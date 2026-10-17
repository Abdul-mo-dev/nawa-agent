//! Legacy-format import: reads an .xls (or anything calamine understands)
//! and writes a minimal .xlsx with values, formulas, and date number formats.
//! Styles beyond date formats are not carried over — the converted file is a
//! fresh workbook, not a byte-preserving edit.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use calamine::{Data, DataType, Reader, SheetType, open_workbook_auto};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::SidecarError;
mod formula;

#[derive(Debug)]
pub struct ConvertResult {
    pub sheets: usize,
    pub cells: usize,
    pub formulas_as_values: usize,
    pub formula_read_failures: usize,
}

// Conversion resource budgets (workbook-import memory containment).
//
// The host caps imported sources at 64 MiB compressed, but a small
// compressed file can describe a gigantic grid: calamine 0.36 builds dense
// `Range`s eagerly (the ODS reader expands repeats at open, up to 100M
// cells; the xlsx/xlsb readers collect sparse cells then allocate the whole
// bounding box in `Range::from_sparse`, so two stored cells 17B cells apart
// allocate the whole box). Conversion runs in the shared sidecar, so such an
// input exhausts memory for every open workbook, not just the import. The
// preflights below therefore run BEFORE `open_workbook_auto` (critical: the
// ODS expansion happens inside open, and the xls DIMENSIONS record drives a
// large `Vec::reserve` at open) and refuse with a `SidecarError::Workbook`
// that names the dimensions, so the host can tell a hostile grid from a
// corrupt file.
//
// Worst-case transient-memory rationale for the shared sidecar on a typical
// 8 GiB desktop (a dense `Data` is tens of bytes plus string storage):
// - 1 GiB total inflated zip size is 16x the 64 MiB host cap. Legit
//   spreadsheets rarely compress better than ~10:1, so anything past this is
//   either hostile or too big to convert safely next to live sessions.
// - 10M cells per sheet bounding box peaks around half a GiB transient for
//   one hostile sheet, well clear of desktop headroom.
// - 30M cells total across sheets: conversion parses one sheet at a time but
//   accumulates output XML, so the total bounds the whole job.
// - 120 s conversion deadline is a backstop only. The dominant cost
//   (calamine's internal parse) is not interruptible, so the preflights above
//   are the real containment; the deadline catches pathological
//   translation/output stages. It is checked at cheap points (per sheet, per
//   emitted row) via `deadline_exceeded`, which takes both instants so unit
//   tests never sleep.
//
// Known trade: a sheet whose *declared* dimensions cover a near-full grid
// (e.g. sheet-wide formatting extending the used range) is refused even when
// its stored cells are few, because a declared box cannot be told apart from
// a lying one without trusting more of the file. The refusal message tells
// the user to narrow the used range.
pub(crate) const MAX_CONVERT_UNCOMPRESSED_BYTES: u64 = 1 << 30;
pub(crate) const MAX_CONVERT_PART_BYTES: u64 = 64 << 20;
pub(crate) const MAX_CONVERT_XML_BYTES: u64 = 256 << 20;
pub(crate) const MAX_CONVERT_SHEET_CELLS: u64 = 10_000_000;
pub(crate) const MAX_CONVERT_TOTAL_CELLS: u64 = 30_000_000;
pub(crate) const CONVERT_DEADLINE: Duration = Duration::from_secs(120);

/// Pure, instantly unit-testable deadline predicate: `start` and `now` are
/// both parameters so tests use synthetic instants instead of sleeping.
pub(crate) fn deadline_exceeded(start: Instant, now: Instant) -> bool {
    now.saturating_duration_since(start) > CONVERT_DEADLINE
}

fn huge_dimensions_error(sheet: &str, rows: u64, cols: u64, cells: u64) -> SidecarError {
    SidecarError::Workbook(format!(
        "Workbook conversion refuses huge dimensions: sheet '{sheet}' spans about {cells} cells \
         ({rows} rows by {cols} columns), over the {MAX_CONVERT_SHEET_CELLS} cells-per-sheet \
         conversion budget. Narrow the used range (clear formatting far outside the data) and try again."
    ))
}

/// Tracks the running conversion against the budgets above, both during
/// preflight (estimated boxes, before any dense allocation) and during
/// conversion (actual ranges read back, as a backstop).
struct ConvertBudget {
    start: Instant,
    total_cells: u64,
}

impl ConvertBudget {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            total_cells: 0,
        }
    }

    fn check_time(&self) -> Result<(), SidecarError> {
        if deadline_exceeded(self.start, Instant::now()) {
            return Err(SidecarError::Workbook(format!(
                "Workbook conversion exceeded the {} s conversion deadline; \
                 the workbook is too large to convert in the import process.",
                CONVERT_DEADLINE.as_secs()
            )));
        }
        Ok(())
    }

    fn check_xml_bytes(&self, bytes: u64) -> Result<(), SidecarError> {
        if bytes > MAX_CONVERT_XML_BYTES {
            return Err(SidecarError::Workbook(format!(
                "Workbook conversion exceeds the {MAX_CONVERT_XML_BYTES} byte output XML conversion budget. Narrow the workbook and try again."
            )));
        }
        Ok(())
    }

    fn add_sheet(&mut self, sheet: &str, rows: u64, cols: u64) -> Result<(), SidecarError> {
        self.check_box(sheet, rows, cols)?;
        self.total_cells = self
            .total_cells
            .saturating_add(rows.saturating_mul(cols.max(1)));
        if self.total_cells > MAX_CONVERT_TOTAL_CELLS {
            return Err(SidecarError::Workbook(format!(
                "Workbook conversion refuses huge dimensions: the sheets converted so far total \
                 about {} cells, over the {MAX_CONVERT_TOTAL_CELLS} conversion budget.",
                self.total_cells
            )));
        }
        Ok(())
    }

    /// Per-sheet refusal without touching the running total, for the eager
    /// midpoint checks while a sheet still streams: running maxima only grow,
    /// so an over-budget product now means an over-budget final box and the
    /// scan can stop without reading the rest of the part. Also used for the
    /// post-read backstop below, which must not double-count the preflight
    /// estimate towards the total.
    fn check_box(&self, sheet: &str, rows: u64, cols: u64) -> Result<(), SidecarError> {
        // Empty repeated rows still allocate row containers in eager readers.
        // They must have a cost even when the reported column count is zero.
        let cells = rows.saturating_mul(cols.max(1));
        if rows > 1_048_576 || cols > 16_384 {
            return Err(SidecarError::Workbook(format!(
                "Workbook conversion refuses huge dimensions: sheet '{sheet}' has {rows} rows by \
                 {cols} columns, outside the Excel grid conversion budget."
            )));
        }
        if cells > MAX_CONVERT_SHEET_CELLS {
            return Err(huge_dimensions_error(sheet, rows, cols, cells));
        }
        Ok(())
    }

    /// Conversion-phase backstop: counts actually emitted cells towards the
    /// running total, for readers that yield more than preflight estimated
    /// (unknown formats have no extent scan).
    fn add_emitted_cells(&mut self, sheet: &str, count: u64) -> Result<(), SidecarError> {
        self.total_cells = self.total_cells.saturating_add(count);
        if self.total_cells > MAX_CONVERT_TOTAL_CELLS {
            return Err(SidecarError::Workbook(format!(
                "Workbook conversion refuses huge dimensions: sheet '{sheet}' pushed the converted \
                 total past about {} emitted cells, over the {MAX_CONVERT_TOTAL_CELLS} conversion budget.",
                self.total_cells
            )));
        }
        Ok(())
    }
}

/// Dimension preflight dispatcher. Runs before `open_workbook_auto`; refusals
/// name the dimensions, while anything merely unreadable falls through so
/// calamine (or the IO layer) reports the authoritative error instead of this
/// preflight masking a corrupt file as a budget refusal.
fn preflight_convert(source: &Path) -> Result<(), SidecarError> {
    if source
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("xls"))
    {
        return preflight_xls(source);
    }
    let mut archive = match zip::ZipArchive::new(File::open(source)?) {
        Ok(archive) => archive,
        Err(_) => return Ok(()),
    };
    preflight_zip(&mut archive)
}

/// Uncompressed-size preflight for ZIP formats (xlsx family, xlsb, ods):
/// sums the central-directory sizes with no inflation. A zip bomb inflates
/// far past its 64 MiB compressed cap before any XML is even read.
fn preflight_zip(archive: &mut zip::ZipArchive<File>) -> Result<(), SidecarError> {
    let mut names: Vec<String> = Vec::new();
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index)?;
        if entry.size() > MAX_CONVERT_PART_BYTES {
            return Err(SidecarError::Workbook(format!(
                "Workbook conversion refuses this file: part '{}' inflates to more than {MAX_CONVERT_PART_BYTES} bytes uncompressed, over the per-part conversion budget.",
                entry.name()
            )));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_CONVERT_UNCOMPRESSED_BYTES {
            return Err(SidecarError::Workbook(format!(
                "Workbook conversion refuses this file: it inflates to more than \
                 {MAX_CONVERT_UNCOMPRESSED_BYTES} bytes uncompressed, over the conversion budget. \
                 Narrow the workbook and try again."
            )));
        }
        names.push(entry.name().to_owned());
    }
    let mut budget = ConvertBudget::new();
    let has_ods_content = names.iter().any(|name| name == "content.xml");
    for name in &names {
        if name == "content.xml" && has_ods_content {
            scan_ods_content(archive, name, &mut budget)?;
        } else if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            scan_xlsx_sheet(archive, name, &mut budget)?;
        } else if name.starts_with("xl/worksheets/sheet") && name.ends_with(".bin") {
            scan_xlsb_sheet_part(archive, name, &mut budget)?;
        }
    }
    Ok(())
}

/// Parses an `A1`-style cell reference into 1-based (row, column) counts.
fn parse_cell_ref(reference: &str) -> Option<(u64, u64)> {
    let split = reference.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = reference.split_at(split);
    if letters.is_empty() || digits.is_empty() {
        return None;
    }
    let mut column = 0u64;
    for byte in letters.bytes() {
        if !byte.is_ascii_alphabetic() {
            return None;
        }
        column = column
            .checked_mul(26)?
            .checked_add((byte.to_ascii_uppercase() - b'A') as u64 + 1)?;
    }
    let row: u64 = digits.parse().ok()?;
    if row == 0 || column == 0 {
        return None;
    }
    Some((row, column))
}

/// Parses an xlsx `<dimension ref="A1:B2"/>` (or single-cell `ref="A1"`)
/// into 1-based (rows, columns) extents. Unparseable refs return `None` so
/// the caller defers to calamine instead of refusing a merely odd file.
fn parse_dimension_ref(value: &str) -> Option<(u64, u64)> {
    let mut parts = value.split(':');
    let first = parts.next()?.trim();
    let last = parts.next_back().map(str::trim).unwrap_or(first);
    let (first_row, first_col) = parse_cell_ref(first)?;
    let (last_row, last_col) = parse_cell_ref(last)?;
    Some((
        last_row.saturating_sub(first_row) + 1,
        last_col.saturating_sub(first_col) + 1,
    ))
}

/// Reads one raw attribute value without entity decoding (refs and repeat
/// counts never contain entities); `None` on anything unexpected, so odd
/// files defer to calamine instead of tripping the budget scan.
fn raw_attr<R: BufRead>(
    xml: &quick_xml::Reader<R>,
    element: &quick_xml::events::BytesStart<'_>,
    name: &[u8],
) -> Option<String> {
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute.ok()?;
        if attribute.key.local_name().as_ref() == name {
            return attribute
                .decode_and_unescape_value(xml.decoder())
                .ok()
                .map(|value| value.into_owned());
        }
    }
    None
}

/// xlsx dimension preflight: streams one sheet part with bounded memory
/// (reused event buffer, no materialised XML) and refuses as soon as the
/// declared `<dimension>` box or the stored-cell box exceeds budget. The
/// stored-cell box is what calamine's `Range::from_sparse` allocates; the
/// declared box is checked too because a lying dimension is hostile by
/// itself (see the budget comment above for the stale-dimension trade).
/// XML that fails to parse falls through (`Ok`) so calamine reports it.
fn scan_xlsx_sheet(
    archive: &mut zip::ZipArchive<File>,
    entry_name: &str,
    budget: &mut ConvertBudget,
) -> Result<(), SidecarError> {
    let entry = match archive.by_name(entry_name) {
        Ok(entry) => entry,
        Err(_) => return Ok(()),
    };
    let mut xml = quick_xml::Reader::from_reader(BufReader::new(entry));
    let mut buffer = Vec::new();
    let mut dim_rows = 0u64;
    let mut dim_cols = 0u64;
    let mut max_row = 0u64;
    let mut max_col = 0u64;
    let mut row = 0u64;
    let mut next_col = 1u64;
    loop {
        buffer.clear();
        let event = match xml.read_event_into(&mut buffer) {
            Ok(event) => event,
            Err(_) => return Ok(()),
        };
        match event {
            quick_xml::events::Event::Eof => break,
            quick_xml::events::Event::Start(element) | quick_xml::events::Event::Empty(element) => {
                match element.local_name().as_ref() {
                    b"dimension" => {
                        if let Some(value) = raw_attr(&xml, &element, b"ref")
                            && let Some((rows, cols)) = parse_dimension_ref(&value)
                        {
                            dim_rows = dim_rows.max(rows);
                            dim_cols = dim_cols.max(cols);
                            budget.check_box(entry_name, dim_rows, dim_cols)?;
                        }
                    }
                    b"row" => {
                        if let Some(value) = raw_attr(&xml, &element, b"r")
                            && let Ok(number) = value.parse::<u64>()
                            && number > 0
                        {
                            row = number;
                        } else {
                            row = row.saturating_add(1);
                        }
                        next_col = 1;
                    }
                    b"c" => {
                        let (cell_row, cell_col) = raw_attr(&xml, &element, b"r")
                            .and_then(|value| parse_cell_ref(&value))
                            .unwrap_or((row.max(1), next_col));
                        row = row.max(cell_row);
                        next_col = cell_col.saturating_add(1);
                        max_row = max_row.max(cell_row);
                        max_col = max_col.max(cell_col);
                        // Running maxima only grow, so an over-budget product
                        // now means an over-budget final box: stop streaming.
                        budget.check_box(entry_name, max_row, max_col)?;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // Count the sheet once towards the total: the declared and stored boxes
    // were each checked eagerly above, so re-add only the larger here. The
    // per-sheet re-check inside `add_sheet` passes again harmlessly.
    budget.add_sheet(entry_name, dim_rows.max(max_row), dim_cols.max(max_col))?;
    Ok(())
}

/// ODS dimension preflight: streams `content.xml` with bounded memory and
/// counts table extents exactly the way calamine 0.36 expands them — row
/// totals honour `number-rows-repeated`, per-row widths honour
/// `number-columns-repeated` on both `table-cell` and `covered-table-cell`
/// (trailing empty repeats never materialise, but leading/empty repeated
/// rows still expand into the dense range, so they count here too). Refuses
/// as soon as a sheet's rows-by-width product exceeds budget; unparseable
/// XML or attributes fall through so calamine reports the file.
fn scan_ods_content(
    archive: &mut zip::ZipArchive<File>,
    entry_name: &str,
    budget: &mut ConvertBudget,
) -> Result<(), SidecarError> {
    struct Sheet {
        label: String,
        rows: u64,
        width_max: u64,
        row_width: u64,
        row_repeat: u64,
        in_row: bool,
    }
    let entry = match archive.by_name(entry_name) {
        Ok(entry) => entry,
        Err(_) => return Ok(()),
    };
    let mut xml = quick_xml::Reader::from_reader(BufReader::new(entry));
    let mut buffer = Vec::new();
    let mut sheets: Vec<Sheet> = Vec::new();
    // Repeat attributes that fail to parse fall back to 1: calamine errors on
    // them before expanding anything, so undercounting here cannot hide an
    // allocation (calamine rejects the file first).
    loop {
        buffer.clear();
        let event = match xml.read_event_into(&mut buffer) {
            Ok(event) => event,
            Err(_) => return Ok(()),
        };
        // Discriminant-only match: no bindings, so `event` stays usable below.
        let empty = matches!(event, quick_xml::events::Event::Empty(_));
        match event {
            quick_xml::events::Event::Eof => break,
            quick_xml::events::Event::Start(element) | quick_xml::events::Event::Empty(element) => {
                match element.local_name().as_ref() {
                    b"table" => {
                        let label = raw_attr(&xml, &element, b"name")
                            .unwrap_or_else(|| format!("table {}", sheets.len() + 1));
                        if empty {
                            budget.add_sheet(&label, 0, 0)?;
                        } else {
                            sheets.push(Sheet {
                                label,
                                rows: 0,
                                width_max: 0,
                                row_width: 0,
                                row_repeat: 1,
                                in_row: false,
                            });
                        }
                    }
                    b"table-row" => {
                        let repeat = raw_attr(&xml, &element, b"number-rows-repeated")
                            .and_then(|value| value.parse::<u64>().ok())
                            .unwrap_or(1)
                            .max(1);
                        if let Some(current) = sheets.last_mut() {
                            current.in_row = true;
                            current.row_width = 0;
                            current.row_repeat = repeat;
                            if empty {
                                current.in_row = false;
                                current.rows = current.rows.saturating_add(current.row_repeat);
                                current.width_max = current.width_max.max(current.row_width);
                                let label = current.label.clone();
                                let (rows, width) = (current.rows, current.width_max);
                                budget.check_box(&label, rows, width)?;
                            }
                        }
                    }
                    b"table-cell" | b"covered-table-cell" => {
                        if let Some(current) = sheets.last_mut()
                            && current.in_row
                        {
                            let repeats = raw_attr(&xml, &element, b"number-columns-repeated")
                                .and_then(|value| value.parse::<u64>().ok())
                                .unwrap_or(1)
                                .max(1);
                            current.row_width = current.row_width.saturating_add(repeats);
                        }
                    }
                    _ => {}
                }
            }
            quick_xml::events::Event::End(element) => match element.local_name().as_ref() {
                b"table-row" => {
                    if let Some(current) = sheets.last_mut()
                        && current.in_row
                    {
                        current.in_row = false;
                        current.rows = current.rows.saturating_add(current.row_repeat);
                        current.width_max = current.width_max.max(current.row_width);
                        current.row_width = 0;
                        let label = current.label.clone();
                        let (rows, width) = (current.rows, current.width_max);
                        budget.check_box(&label, rows, width)?;
                    }
                }
                b"table" => {
                    if let Some(sheet) = sheets.pop() {
                        budget.add_sheet(&sheet.label, sheet.rows, sheet.width_max)?;
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    Ok(())
}

/// Reads one BIFF12 7-bit varint record type (1-2 bytes, mirroring calamine
/// 0.36's `RecordIter::read_type`); `None` at clean EOF or on truncation, in
/// which case the caller defers to calamine.
fn read_biff12_type<R: Read>(stream: &mut R) -> Option<u16> {
    let mut byte = [0u8; 1];
    stream.read_exact(&mut byte).ok()?;
    let first = byte[0];
    if first & 0x80 == 0 {
        return Some(first as u16);
    }
    stream.read_exact(&mut byte).ok()?;
    Some((first & 0x7F) as u16 | ((byte[0] & 0x7F) as u16) << 7)
}

/// Reads one BIFF12 7-bit varint record length (up to 4 bytes, mirroring
/// calamine 0.36's `RecordIter::fill_buffer` framing).
fn read_biff12_len<R: Read>(stream: &mut R) -> Option<u64> {
    let mut length = 0u64;
    for shift in (0..28).step_by(7) {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).ok()?;
        length |= ((byte[0] & 0x7F) as u64) << shift;
        if byte[0] & 0x80 == 0 {
            return Some(length);
        }
    }
    None
}

/// Discards `count` stream bytes with a small fixed buffer; `false` on
/// truncation (the caller then defers to calamine).
fn skip_stream_bytes<R: Read>(stream: &mut R, mut count: u64) -> bool {
    let mut chunk = [0u8; 8192];
    while count > 0 {
        let want = count.min(chunk.len() as u64) as usize;
        match stream.read(&mut chunk[..want]) {
            Ok(0) => return false,
            Ok(read) => count -= read as u64,
            Err(_) => return false,
        }
    }
    true
}

fn read_exact_or_none<R: Read, const N: usize>(stream: &mut R) -> Option<[u8; N]> {
    let mut head = [0u8; N];
    stream.read_exact(&mut head).ok()?;
    Some(head)
}

/// xlsb row-extent preflight: streams one `xl/worksheets/sheetN.bin` part
/// with BIFF12 framing copied from calamine 0.36 (`BrtWsDim` 0x0094 carries
/// rwMic/rwMac/colMic/colMac u32s; `BrtRowHdr` 0x0000 carries the row;
/// cell records 0x0001-0x000B carry the column in their first u32). Tracks
/// the larger of the declared `BrtWsDim` box and the stored-cell box and
/// stops at `BrtEndSheetData` 0x0092. Refuses eagerly; anything unreadable
/// falls through so calamine reports the file.
fn scan_xlsb_sheet_part(
    archive: &mut zip::ZipArchive<File>,
    entry_name: &str,
    budget: &mut ConvertBudget,
) -> Result<(), SidecarError> {
    let entry = match archive.by_name(entry_name) {
        Ok(entry) => entry,
        Err(_) => return Ok(()),
    };
    scan_xlsb_stream(&mut BufReader::new(entry), entry_name, budget)
}

fn scan_xlsb_stream<R: Read>(
    mut stream: &mut R,
    sheet: &str,
    budget: &mut ConvertBudget,
) -> Result<(), SidecarError> {
    let mut dim_rows = 0u64;
    let mut dim_cols = 0u64;
    let mut max_row = 0u64;
    let mut max_col = 0u64;
    let mut current_row = 0u64;
    loop {
        let Some(record) = read_biff12_type(&mut stream) else {
            break;
        };
        let Some(length) = read_biff12_len(&mut stream) else {
            break;
        };
        match record {
            0x0094 => {
                // BrtWsDim: rwMic, rwMac, colMic, colMac (u32 LE).
                if length >= 16 {
                    let Some(head) = read_exact_or_none::<_, 16>(&mut stream) else {
                        break;
                    };
                    let first_row = u32::from_le_bytes(head[0..4].try_into().unwrap()) as u64;
                    let end_row = u32::from_le_bytes(head[4..8].try_into().unwrap()) as u64;
                    let first_col = u32::from_le_bytes(head[8..12].try_into().unwrap()) as u64;
                    let end_col = u32::from_le_bytes(head[12..16].try_into().unwrap()) as u64;
                    dim_rows = dim_rows.max(end_row.saturating_sub(first_row) + 1);
                    dim_cols = dim_cols.max(end_col.saturating_sub(first_col) + 1);
                    budget.check_box(sheet, dim_rows, dim_cols)?;
                    if !skip_stream_bytes(&mut stream, length - 16) {
                        break;
                    }
                } else if !skip_stream_bytes(&mut stream, length) {
                    break;
                }
            }
            0x0000 => {
                // BrtRowHdr: row in the first u32. A bare row header
                // allocates nothing (only cells do), so it only moves the
                // current row; the box is checked on cell records below.
                if let Some(head) = read_exact_or_none::<_, 4>(&mut stream) {
                    current_row = u32::from_le_bytes(head) as u64;
                } else {
                    break;
                }
                if !skip_stream_bytes(&mut stream, length.saturating_sub(4)) {
                    break;
                }
            }
            0x0001..=0x000B => {
                // Cell records: column in the first u32; the row is the last
                // BrtRowHdr (calamine pairs them the same way).
                if let Some(head) = read_exact_or_none::<_, 4>(&mut stream) {
                    let column = u32::from_le_bytes(head) as u64;
                    max_col = max_col.max(column.saturating_add(1));
                    max_row = max_row.max(current_row.saturating_add(1));
                    budget.check_box(sheet, max_row, max_col)?;
                } else {
                    break;
                }
                if !skip_stream_bytes(&mut stream, length.saturating_sub(4)) {
                    break;
                }
            }
            0x0092 => break, // BrtEndSheetData: no more cells follow.
            _ => {
                if !skip_stream_bytes(&mut stream, length) {
                    break;
                }
            }
        }
    }
    budget.add_sheet(sheet, dim_rows.max(max_row), dim_cols.max(max_col))?;
    Ok(())
}

/// Cap on how much of an .xls `Workbook` stream the DIMENSIONS scan will
/// read: BIFF is uncompressed, so the stream cannot legitimately dwarf the
/// host's 64 MiB file cap; anything past this is hostile by itself.
const MAX_XLS_WORKBOOK_STREAM_BYTES: u64 = 256 << 20;

/// xls dimension preflight (.xls is CFB, not ZIP, so the zip preflight
/// cannot see it): walks the BIFF record stream (`u16` opcode + `u16` length)
/// and measures every DIMENSIONS record the way calamine 0.36's
/// `parse_dimensions` does (BIFF8 `0x0200`, 14 bytes: rwMic/rwMac u32 then
/// colMic/colMac u16; older 10-byte form with u16 rows). The DIMENSIONS box
/// drives calamine's `Vec::reserve` at open, so this must run before
/// `open_workbook_auto`. BIFF8 grids cap at 65,536 x 256 (16.7M cells), so a
/// full-grid claim also trips the per-sheet budget. Anything unreadable —
/// not CFB, no Workbook/Book stream, truncated records — falls through (`Ok`)
/// so calamine reports the file.
fn preflight_xls(source: &Path) -> Result<(), SidecarError> {
    let mut compound = match cfb::open(source) {
        Ok(compound) => compound,
        Err(_) => return Ok(()),
    };
    let stream_name = if compound.exists("/Workbook") {
        "/Workbook"
    } else if compound.exists("/Book") {
        "/Book"
    } else {
        return Ok(());
    };
    let stream = match compound.open_stream(stream_name) {
        Ok(stream) => stream,
        Err(_) => return Ok(()),
    };
    let mut bytes = Vec::new();
    match stream
        .take(MAX_XLS_WORKBOOK_STREAM_BYTES + 1)
        .read_to_end(&mut bytes)
    {
        Ok(_) => {}
        Err(_) => return Ok(()),
    }
    if bytes.len() as u64 > MAX_XLS_WORKBOOK_STREAM_BYTES {
        return Err(SidecarError::Workbook(format!(
            "Workbook conversion refuses huge dimensions: the .xls workbook stream is larger than \
             {MAX_XLS_WORKBOOK_STREAM_BYTES} bytes, over the conversion budget."
        )));
    }
    let mut budget = ConvertBudget::new();
    let mut sheet_index = 0u32;
    let mut max_row = 0u64;
    let mut max_col = 0u64;
    let mut position = 0usize;
    while position + 4 <= bytes.len() {
        let opcode = u16::from_le_bytes(bytes[position..position + 2].try_into().unwrap());
        let length =
            u16::from_le_bytes(bytes[position + 2..position + 4].try_into().unwrap()) as usize;
        position += 4;
        if position + length > bytes.len() {
            break;
        }
        let record = &bytes[position..position + length];
        position += length;
        // DIMENSIONS can understate the stored range. Cell coordinates drive
        // Range::from_sparse too, so bound them before handing BIFF to calamine.
        if matches!(
            opcode,
            0x0201 | 0x0203 | 0x0204 | 0x0205 | 0x0006 | 0x00FD | 0x00BD | 0x00BE
        ) && record.len() >= 6
        {
            let row = u16::from_le_bytes(record[0..2].try_into().unwrap()) as u64 + 1;
            let mut col = u16::from_le_bytes(record[2..4].try_into().unwrap()) as u64 + 1;
            if matches!(opcode, 0x00BD | 0x00BE) {
                col = col.max(
                    u16::from_le_bytes(record[record.len() - 2..].try_into().unwrap()) as u64 + 1,
                );
            }
            max_row = max_row.max(row);
            max_col = max_col.max(col);
            budget.check_box(&format!("sheet {}", sheet_index + 1), max_row, max_col)?;
        }
        if opcode == 0x000A {
            if max_row > 0 {
                sheet_index += 1;
                budget.add_sheet(&format!("sheet {sheet_index}"), max_row, max_col)?;
            }
            max_row = 0;
            max_col = 0;
        }
        let measured = match (opcode, record.len()) {
            (0x0200, 14) => Some((
                u32::from_le_bytes(record[0..4].try_into().unwrap()),
                u32::from_le_bytes(record[4..8].try_into().unwrap()),
                u16::from_le_bytes(record[8..10].try_into().unwrap()) as u32,
                u16::from_le_bytes(record[10..12].try_into().unwrap()) as u32,
            )),
            (0x0000, 10) => Some((
                u16::from_le_bytes(record[0..2].try_into().unwrap()) as u32,
                u16::from_le_bytes(record[2..4].try_into().unwrap()) as u32,
                u16::from_le_bytes(record[4..6].try_into().unwrap()) as u32,
                u16::from_le_bytes(record[6..8].try_into().unwrap()) as u32,
            )),
            _ => None,
        };
        if let Some((first_row, end_row, mut first_col, end_col)) = measured {
            // Same clamping as calamine 0.36: an impossible first column
            // means the record starts at 0 (covers tests/OOM_alloc2.xls).
            if 0xFF < first_col || end_col < first_col {
                first_col = 0;
            }
            let (rows, cols) = if end_row >= 1 && end_col >= 1 {
                (
                    (end_row.saturating_sub(first_row)) as u64,
                    (end_col.saturating_sub(first_col)) as u64,
                )
            } else {
                (1, 1)
            };
            max_row = max_row.max(rows.max(1));
            max_col = max_col.max(cols.max(1));
            budget.check_box(&format!("sheet {}", sheet_index + 1), max_row, max_col)?;
        }
    }
    if max_row > 0 {
        budget.add_sheet(&format!("sheet {}", sheet_index + 1), max_row, max_col)?;
    }
    Ok(())
}

pub fn convert_to_xlsx(source: &Path, target: &Path) -> Result<ConvertResult, SidecarError> {
    if source.canonicalize()?
        == target
            .canonicalize()
            .unwrap_or_else(|_| target.to_path_buf())
    {
        return Err(SidecarError::Workbook(
            "Workbook import cannot overwrite its source.".into(),
        ));
    }
    let ods = source
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ods"));
    let xls = source
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("xls"));
    // Resource preflight before any dense allocation: the ODS reader expands
    // repeats inside `open_workbook_auto`, and the xls DIMENSIONS record
    // drives a large reserve there too.
    preflight_convert(source)?;
    let mut budget = ConvertBudget::new();
    let mut workbook = open_workbook_auto(source)
        .map_err(|error| SidecarError::Workbook(format!("Unable to read the workbook: {error}")))?;
    // Charts and macro sheets are not cell worksheets and cannot be read as ranges.
    let names: Vec<String> = workbook
        .sheets_metadata()
        .iter()
        .filter(|sheet| sheet.typ == SheetType::WorkSheet)
        .map(|sheet| sheet.name.clone())
        .collect();
    let defined_names: Vec<String> = workbook
        .defined_names()
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    if names.is_empty() {
        return Err(SidecarError::Workbook("The workbook has no sheets.".into()));
    }

    let mut sheet_xmls: Vec<String> = Vec::new();
    let mut output_xml_bytes = 0u64;
    let mut cells = 0usize;
    let mut formulas_as_values = 0usize;
    let mut formula_read_failures = 0usize;
    for name in &names {
        budget.check_time()?;
        let range = workbook
            .worksheet_range(name)
            .map_err(|error| SidecarError::Workbook(format!("Sheet {name}: {error}")))?;
        // Backstop for readers that yield more than preflight estimated
        // (unknown formats have no extent scan). This runs after calamine's
        // dense allocation, so it cannot reclaim that memory — it aborts
        // before output accumulation and later sheets instead. Known formats
        // are contained by `preflight_convert` above.
        if let (Some(start), Some(end)) = (range.start(), range.end()) {
            budget.check_box(
                name,
                (end.0.saturating_sub(start.0) + 1) as u64,
                (end.1.saturating_sub(start.1) + 1) as u64,
            )?;
        }
        let formulas = match workbook.worksheet_formula(name) {
            Ok(range) => Some(range),
            Err(_) => {
                formula_read_failures += 1;
                None
            }
        };
        let mut formula_map: HashMap<(u32, u32), String> = HashMap::new();
        if let Some(formula_range) = formulas {
            let (start_row, start_col) = formula_range.start().unwrap_or((0, 0));
            for (row, column, formula) in formula_range.used_cells() {
                if !formula.is_empty() {
                    let translated = if ods {
                        formula::translate_ods(formula, &names)
                    } else if formula::has_nonportable_excel_refs(formula, &defined_names)
                        || (xls && formula::has_invalid_xls_refs(formula))
                    {
                        None
                    } else {
                        Some(formula.trim_start_matches('=').to_string())
                    };
                    if let Some(translated) = translated {
                        formula_map.insert(
                            (start_row + row as u32, start_col + column as u32),
                            translated,
                        );
                    } else {
                        // Preserve the source's cached result when translation is unavailable.
                        formulas_as_values += 1;
                    }
                }
            }
        }
        let (xml, sheet_cells) = worksheet_xml(&range, &formula_map, &budget)?;
        budget.add_emitted_cells(name, sheet_cells as u64)?;
        cells += sheet_cells;
        output_xml_bytes = output_xml_bytes.saturating_add(xml.len() as u64);
        budget.check_xml_bytes(output_xml_bytes)?;
        sheet_xmls.push(xml);
    }

    let file = File::create(target)?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut add = |name: &str, content: &str| -> Result<(), SidecarError> {
        writer.start_file(name, options)?;
        writer.write_all(content.as_bytes())?;
        Ok(())
    };

    add("[Content_Types].xml", &content_types_xml(names.len()))?;
    add("_rels/.rels", ROOT_RELS)?;
    add("xl/workbook.xml", &workbook_xml(&names))?;
    add(
        "xl/_rels/workbook.xml.rels",
        &workbook_rels_xml(names.len()),
    )?;
    add("xl/styles.xml", STYLES_XML)?;
    for (index, xml) in sheet_xmls.iter().enumerate() {
        add(&format!("xl/worksheets/sheet{}.xml", index + 1), xml)?;
    }
    writer.finish()?.sync_all()?;
    Ok(ConvertResult {
        sheets: names.len(),
        cells,
        formulas_as_values,
        formula_read_failures,
    })
}

fn worksheet_xml(
    range: &calamine::Range<Data>,
    formulas: &HashMap<(u32, u32), String>,
    budget: &ConvertBudget,
) -> Result<(String, usize), SidecarError> {
    // Rows carrying values plus rows carrying only formulas.
    let mut rows: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
    let mut cells = 0usize;
    let mut cell_xml_bytes = 0u64;
    let (start_row, start_col) = range.start().unwrap_or((0, 0));
    for (row, column, value) in range.used_cells() {
        let absolute = (start_row + row as u32, start_col + column as u32);
        let formula = formulas.get(&absolute).map(String::as_str);
        if let Some(cell) = cell_xml(absolute, value, formula) {
            cell_xml_bytes = cell_xml_bytes.saturating_add(cell.len() as u64);
            budget.check_xml_bytes(cell_xml_bytes)?;
            cells += 1;
            rows.entry(absolute.0).or_default().push((absolute.1, cell));
        }
    }
    for (position, formula) in formulas {
        let covered = range
            .get_value((position.0, position.1))
            .is_some_and(|v| *v != Data::Empty);
        if !covered {
            cells += 1;
            let cell = format!(
                r#"<c r="{}"><f>{}</f></c>"#,
                cell_reference(position.0, position.1),
                escape_xml(formula)
            );
            cell_xml_bytes = cell_xml_bytes.saturating_add(cell.len() as u64);
            budget.check_xml_bytes(cell_xml_bytes)?;
            rows.entry(position.0).or_default().push((position.1, cell));
        }
    }

    let mut row_numbers: Vec<u32> = rows.keys().copied().collect();
    row_numbers.sort_unstable();
    let mut body = String::new();
    for row in row_numbers {
        // Deadline checkpoint on the emit path (one clock read per sparse
        // row). Calamine's own parse above is not interruptible, so this
        // only bounds the translation/output stage; the preflights bound the
        // parse stage. Unit coverage lives on `deadline_exceeded` (synthetic
        // instants, no sleeps) since no test fixture can run 120 s.
        budget.check_time()?;
        let mut line = rows.remove(&row).unwrap_or_default();
        line.sort_unstable_by_key(|(column, _)| *column);
        body.push_str(&format!(r#"<row r="{}">"#, row + 1));
        for (_, cell) in line {
            body.push_str(&cell);
        }
        body.push_str("</row>");
        budget.check_xml_bytes(body.len() as u64)?;
    }

    let dimension = match (range.start(), range.end()) {
        (Some(start), Some(end)) => format!(
            "{}:{}",
            cell_reference(start.0, start.1),
            cell_reference(end.0, end.1),
        ),
        _ => "A1:A1".into(),
    };
    Ok((
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="{dimension}"/><sheetData>{body}</sheetData></worksheet>"#,
        ),
        cells,
    ))
}

fn cell_xml(position: (u32, u32), value: &Data, formula: Option<&str>) -> Option<String> {
    let reference = cell_reference(position.0, position.1);
    let formula_xml = formula
        .map(|text| format!("<f>{}</f>", escape_xml(text)))
        .unwrap_or_default();
    let cell = match value {
        Data::Empty => {
            if formula.is_none() {
                return None;
            }
            format!(r#"<c r="{reference}">{formula_xml}</c>"#)
        }
        Data::String(text) if formula.is_some() => format!(
            r#"<c r="{reference}" t="str">{formula_xml}<v>{}</v></c>"#,
            escape_xml(text),
        ),
        Data::String(text) => format!(
            r#"<c r="{reference}" t="inlineStr">{formula_xml}<is><t xml:space="preserve">{}</t></is></c>"#,
            escape_xml(text),
        ),
        Data::Float(number) => format!(r#"<c r="{reference}">{formula_xml}<v>{number}</v></c>"#),
        Data::Int(number) => format!(r#"<c r="{reference}">{formula_xml}<v>{number}</v></c>"#),
        Data::Bool(flag) => format!(
            r#"<c r="{reference}" t="b">{formula_xml}<v>{}</v></c>"#,
            if *flag { 1 } else { 0 },
        ),
        Data::DateTime(datetime) => {
            let original = datetime.as_f64();
            // Keep 1900 serials (including Excel's fictitious leap day) intact;
            // the calendar conversion identifies the 1462-day 1904 offset.
            let offset = excel_date_serial(value).map_or(0.0, |serial| {
                if (serial - original - 1462.0).abs() < 0.001 {
                    1462.0
                } else {
                    0.0
                }
            });
            let serial = original + offset;
            let style = if serial.fract() == 0.0 { 1 } else { 2 };
            format!(r#"<c r="{reference}" s="{style}">{formula_xml}<v>{serial}</v></c>"#)
        }
        Data::Error(error) => format!(
            r#"<c r="{reference}" t="e">{formula_xml}<v>{}</v></c>"#,
            escape_xml(&error.to_string()),
        ),
        Data::DateTimeIso(_) if excel_date_serial(value).is_some() => {
            let serial = excel_date_serial(value).unwrap();
            let style = if serial.fract() == 0.0 { 1 } else { 2 };
            format!(r#"<c r="{reference}" s="{style}">{formula_xml}<v>{serial}</v></c>"#)
        }
        Data::DateTimeIso(text) | Data::DurationIso(text) => format!(
            r#"<c r="{reference}" t="inlineStr">{formula_xml}<is><t xml:space="preserve">{}</t></is></c>"#,
            escape_xml(text),
        ),
    };
    Some(cell)
}

/// Convert all supported date epochs to the 1900 system of the output package.
fn excel_date_serial(value: &Data) -> Option<f64> {
    let datetime = value
        .as_datetime()
        .or_else(|| value.as_date()?.and_hms_opt(0, 0, 0))?;
    let serial = datetime.and_utc().timestamp_millis() as f64 / 86_400_000.0 + 25_569.0;
    Some(if serial < 61.0 { serial - 1.0 } else { serial })
}

fn cell_reference(row: u32, column: u32) -> String {
    let mut letters = String::new();
    let mut remaining = column + 1;
    while remaining > 0 {
        remaining -= 1;
        letters.insert(0, char::from(b'A' + (remaining % 26) as u8));
        remaining /= 26;
    }
    format!("{letters}{}", row + 1)
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn content_types_xml(sheet_count: usize) -> String {
    let overrides: String = (1..=sheet_count)
        .map(|index| format!(
            r#"<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#,
        ))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{overrides}</Types>"#,
    )
}

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;

fn workbook_xml(names: &[String]) -> String {
    let sheets: String = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            format!(
                r#"<sheet name="{}" sheetId="{}" r:id="rId{}"/>"#,
                escape_xml(name),
                index + 1,
                index + 1,
            )
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{sheets}</sheets></workbook>"#,
    )
}

fn workbook_rels_xml(sheet_count: usize) -> String {
    let mut relationships: String = (1..=sheet_count)
        .map(|index| format!(
            r#"<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>"#,
        ))
        .collect();
    relationships.push_str(&format!(
        r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
        sheet_count + 1,
    ));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{relationships}</Relationships>"#,
    )
}

/// xf 1 = short date (numFmt 14), xf 2 = date+time (numFmt 22).
const STYLES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn read_entry(path: &Path, name: &str) -> String {
        let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        content
    }

    #[test]
    fn converts_a_calamine_readable_workbook_into_minimal_xlsx() {
        // calamine reads xlsx through the same auto-detect path as xls, so a
        // generated xlsx fixture exercises the converter end to end.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.xlsx");
        convert_fixture(&source);
        let target = dir.path().join("converted.xlsx");

        let result = convert_to_xlsx(&source, &target).unwrap();
        assert_eq!(result.sheets, 1);
        assert!(result.cells >= 4);

        let sheet = read_entry(&target, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains(
            r#"<c r="A1" t="inlineStr"><is><t xml:space="preserve">Name &amp; Co</t></is></c>"#
        ));
        assert!(sheet.contains(r#"<c r="B1"><v>42</v></c>"#));
        assert!(sheet.contains(r#"<c r="B2"><f>B1*2</f>"#));
        let workbook = read_entry(&target, "xl/workbook.xml");
        assert!(workbook.contains(r#"<sheet name="Data" sheetId="1" r:id="rId1"/>"#));
    }

    #[test]
    fn converts_real_ods_formulas_dates_and_cached_values() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/workbook-imports/basic.ods");
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("converted.xlsx");
        let result = convert_to_xlsx(&source, &target).unwrap();
        assert_eq!(result.sheets, 2);
        assert_eq!(result.formulas_as_values, 1);
        assert_eq!(result.formula_read_failures, 0);
        let sheet = read_entry(&target, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<f>SUM(A1:B1)</f>"));
        assert!(sheet.contains("<f>'Other Sheet'!A1</f>"));
        assert!(sheet.contains(r#"<c r="C2"><v>42</v></c>"#));
        assert!(sheet.contains(r#"<c r="A2" s="1"><v>45293</v></c>"#));
        assert!(!sheet.contains("of:="));
        assert!(!sheet.contains("UNSUPPORTED("));
    }

    #[test]
    fn converts_genuine_xlsb_and_protects_the_source() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/workbook-imports/any_sheets.xlsb");
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.xlsb");
        std::fs::copy(fixture, &source).unwrap();
        let before = std::fs::read(&source).unwrap();
        assert!(convert_to_xlsx(&source, &source).is_err());
        let target = dir.path().join("converted.xlsx");
        let result = convert_to_xlsx(&source, &target).unwrap();
        let mut original = open_workbook_auto(&source).unwrap();
        let mut converted = open_workbook_auto(&target).unwrap();
        let names: Vec<String> = original
            .sheets_metadata()
            .iter()
            .filter(|sheet| sheet.typ == SheetType::WorkSheet)
            .map(|sheet| sheet.name.clone())
            .collect();
        assert_eq!(result.sheets, names.len());
        assert_eq!(converted.sheet_names(), names);
        for name in names {
            assert_eq!(
                original.worksheet_range(&name).unwrap(),
                converted.worksheet_range(&name).unwrap()
            );
        }
        assert_eq!(std::fs::read(source).unwrap(), before);
    }

    #[test]
    fn converts_genuine_xls_without_misdecoded_relative_ranges() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../test-files/spreadsheet-chat/binary.xls");
        let before = std::fs::read(&source).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("converted.xlsx");
        let result = convert_to_xlsx(&source, &target).unwrap();
        assert_eq!(result.formulas_as_values, 1);
        let xml = read_entry(&target, "xl/worksheets/sheet1.xml");
        assert!(xml.contains(r#"<c r="B5"><v>22.5</v></c>"#));
        assert!(xml.contains("<f>SUM($B$2:$B$4)</f>"));
        assert!(!xml.contains("USN"));
        assert_eq!(std::fs::read(source).unwrap(), before);
    }

    #[test]
    fn converts_xlsb_1904_dates_to_the_output_epoch() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/workbook-imports/date_1904.xlsb");
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("converted.xlsx");
        convert_to_xlsx(&source, &target).unwrap();
        let mut original = open_workbook_auto(&source).unwrap();
        let mut converted = open_workbook_auto(&target).unwrap();
        let mut date_count = 0;
        for name in original.sheet_names().to_vec() {
            let before = original.worksheet_range(&name).unwrap();
            let after = converted.worksheet_range(&name).unwrap();
            for (row, column, value) in before.used_cells() {
                if let Data::DateTime(_) = value {
                    date_count += 1;
                    assert_eq!(
                        value.as_datetime(),
                        after.get((row, column)).unwrap().as_datetime()
                    );
                }
            }
        }
        assert!(date_count > 0);
    }

    fn convert_fixture(path: &Path) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        let mut add = |name: &str, content: &str| {
            writer.start_file(name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        };
        add(
            "[Content_Types].xml",
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        );
        add(
            "_rels/.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        );
        add(
            "xl/workbook.xml",
            r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        );
        add(
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        );
        add(
            "xl/worksheets/sheet1.xml",
            r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name &amp; Co</t></is></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2"><f>B1*2</f><v>84</v></c></row></sheetData></worksheet>"#,
        );
        writer.finish().unwrap();
    }

    // Conversion resource budgets (P8). Every hostile fixture below is a few
    // kilobytes; the tests assert fast refusal plus the refusal wording, not
    // exact memory figures — proving the dense range is never allocated
    // rather than measuring the OOM it would cause.

    fn write_zip_entries(path: &Path, entries: &[(String, String)]) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, content) in entries {
            writer.start_file(name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    fn xlsx_package(sheet_xml: &str) -> Vec<(String, String)> {
        vec![
            (
                "[Content_Types].xml".into(),
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#.into(),
            ),
            (
                "_rels/.rels".into(),
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.into(),
            ),
            (
                "xl/workbook.xml".into(),
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>"#.into(),
            ),
            (
                "xl/_rels/workbook.xml.rels".into(),
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.into(),
            ),
            ("xl/worksheets/sheet1.xml".into(), sheet_xml.into()),
        ]
    }

    fn ods_package(content_xml: &str) -> Vec<(String, String)> {
        vec![
            (
                "mimetype".into(),
                "application/vnd.oasis.opendocument.spreadsheet".into(),
            ),
            ("content.xml".into(), content_xml.into()),
        ]
    }

    fn assert_fast_budget_refusal(result: Result<ConvertResult, SidecarError>, started: Instant) {
        let elapsed = started.elapsed();
        // Plausibility bound, not a benchmark: refusal must stream at most a
        // few kilobytes of XML, never inflate or allocate gigas.
        assert!(
            elapsed < Duration::from_secs(10),
            "budget refusal took too long: {elapsed:?}"
        );
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains("refuses huge dimensions")
                || error.to_string().contains("uncompressed"),
            "unexpected refusal wording: {error}"
        );
    }

    #[test]
    fn refuses_xlsx_with_huge_dimension_and_tiny_content() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("huge-dimension.xlsx");
        write_zip_entries(
            &source,
            &xlsx_package(
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
        );
        assert!(std::fs::metadata(&source).unwrap().len() < 10_000);
        let target = dir.path().join("converted.xlsx");
        let started = Instant::now();
        assert_fast_budget_refusal(convert_to_xlsx(&source, &target), started);
        assert!(!target.exists());
    }

    #[test]
    fn refuses_xlsx_with_far_apart_stored_cells() {
        // Two stored cells whose bounding box alone would make calamine's
        // `Range::from_sparse` allocate ~17B cells; the dimension only
        // repeats the same claim.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("far-apart.xlsx");
        write_zip_entries(
            &source,
            &xlsx_package(
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>2</v></c></row></sheetData></worksheet>"#,
            ),
        );
        assert!(std::fs::metadata(&source).unwrap().len() < 10_000);
        let target = dir.path().join("converted.xlsx");
        let started = Instant::now();
        assert_fast_budget_refusal(convert_to_xlsx(&source, &target), started);
        assert!(!target.exists());
    }

    #[test]
    fn refuses_ods_with_massive_repeated_rows() {
        // calamine 0.36 expands repeats eagerly at open (up to 100M cells),
        // so the preflight must count repeats without expanding them.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("huge-rows.ods");
        write_zip_entries(
            &source,
            &ods_package(
                r#"<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1024"/></table:table-row><table:table-row><table:table-cell office:value-type="string"><text:p>hi</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>"#,
            ),
        );
        assert!(std::fs::metadata(&source).unwrap().len() < 10_000);
        let target = dir.path().join("converted.xlsx");
        let started = Instant::now();
        assert_fast_budget_refusal(convert_to_xlsx(&source, &target), started);
        assert!(!target.exists());
    }

    #[test]
    fn refuses_ods_with_massive_repeated_columns() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("huge-cols.ods");
        write_zip_entries(
            &source,
            &ods_package(
                r#"<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell table:number-columns-repeated="100000000"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>"#,
            ),
        );
        assert!(std::fs::metadata(&source).unwrap().len() < 10_000);
        let target = dir.path().join("converted.xlsx");
        let started = Instant::now();
        assert_fast_budget_refusal(convert_to_xlsx(&source, &target), started);
        assert!(!target.exists());
    }

    #[test]
    fn uncompressed_size_preflight_reads_declared_sizes_without_inflating() {
        // Patches the central-directory size field of a tiny valid package:
        // the preflight must refuse on the declared total without reading a
        // single byte of entry data.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("lying-sizes.xlsx");
        write_zip_entries(
            &source,
            &xlsx_package(
                r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
        );
        let mut bytes = std::fs::read(&source).unwrap();
        let eocd = bytes.len() - 22;
        assert_eq!(&bytes[eocd..eocd + 4], &[0x50, 0x4B, 0x05, 0x06]);
        let central_offset =
            u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        assert_eq!(
            &bytes[central_offset..central_offset + 4],
            &[0x50, 0x4B, 0x01, 0x02]
        );
        bytes[central_offset + 24..central_offset + 28].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&source, &bytes).unwrap();
        // The tampered archive still opens (sizes are unchecked at open); the
        // refusal below therefore proves the preflight summed the lie.
        assert!(
            zip::ZipArchive::new(File::open(&source).unwrap())
                .unwrap()
                .len()
                > 0
        );
        let target = dir.path().join("converted.xlsx");
        let started = Instant::now();
        let error = convert_to_xlsx(&source, &target).unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "size refusal must not inflate data"
        );
        assert!(
            error.to_string().contains("uncompressed"),
            "unexpected refusal wording: {error}"
        );
        assert!(!target.exists());
    }

    #[test]
    fn deadline_check_compares_instants_without_sleeping() {
        let start = Instant::now();
        assert!(!deadline_exceeded(start, start));
        assert!(!deadline_exceeded(start, start + CONVERT_DEADLINE));
        let past = start
            .checked_add(CONVERT_DEADLINE + Duration::from_secs(1))
            .unwrap();
        assert!(deadline_exceeded(start, past));
    }

    #[test]
    fn budget_backstop_checks_boxes_and_counts_emitted_cells() {
        assert_eq!(parse_cell_ref("XFD1048576"), Some((1_048_576, 16_384)));
        assert_eq!(parse_cell_ref("A1"), Some((1, 1)));
        assert_eq!(
            parse_dimension_ref("A1:XFD1048576"),
            Some((1_048_576, 16_384))
        );
        assert_eq!(parse_dimension_ref("B2"), Some((1, 1)));
        assert!(parse_cell_ref("A0").is_none());
        assert!(parse_cell_ref("1A").is_none());
        assert!(parse_dimension_ref("bogus").is_none());

        let budget = ConvertBudget::new();
        budget.check_box("small", 1_000, 1_000).unwrap();
        let error = budget.check_box("huge", 1_048_576, 16_384).unwrap_err();
        assert!(
            error.to_string().contains("refuses huge dimensions"),
            "{error}"
        );

        let mut budget = ConvertBudget::new();
        budget
            .add_emitted_cells("a", MAX_CONVERT_TOTAL_CELLS)
            .unwrap();
        let error = budget.add_emitted_cells("b", 1).unwrap_err();
        assert!(
            error.to_string().contains("refuses huge dimensions"),
            "{error}"
        );
    }

    fn biff12_record(record_type: u16, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        if record_type < 0x80 {
            out.push(record_type as u8);
        } else {
            out.push((record_type as u8 & 0x7F) | 0x80);
            out.push((record_type >> 7) as u8 & 0x7F);
        }
        let mut length = payload.len() as u64;
        loop {
            let byte = (length & 0x7F) as u8;
            length >>= 7;
            if length == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
        out.extend_from_slice(payload);
        out
    }

    fn biff12_row_header(row: u32) -> Vec<u8> {
        let mut payload = row.to_le_bytes().to_vec();
        payload.extend_from_slice(&[0u8; 12]);
        payload
    }

    fn biff12_cell(column: u32) -> Vec<u8> {
        let mut payload = column.to_le_bytes().to_vec();
        payload.extend_from_slice(&[0u8; 12]);
        payload
    }

    #[test]
    fn xlsb_scanner_refuses_huge_ws_dim_and_far_apart_cells() {
        // A full-grid BrtWsDim claim (rwMac/colMac are the hostile part).
        let mut claimed = biff12_record(
            0x0094,
            &[
                0, 0, 0, 0, // rwMic
                0, 0, 16, 0, // rwMac = 1048576
                0, 0, 0, 0, // colMic
                0, 64, 0, 0, // colMac = 16384
            ],
        );
        claimed.extend(biff12_record(0x0092, &[]));
        let mut budget = ConvertBudget::new();
        let error = scan_xlsb_stream(&mut std::io::Cursor::new(&claimed), "sheet1", &mut budget)
            .unwrap_err();
        assert!(
            error.to_string().contains("refuses huge dimensions"),
            "{error}"
        );

        // Small WsDim but stored cells spanning the full grid: this is the
        // shape that makes calamine's `Range::from_sparse` allocate ~17B.
        let mut far = biff12_record(0x0094, &[0u8; 16]);
        far.extend(biff12_record(0x0000, &biff12_row_header(0)));
        far.extend(biff12_record(0x0005, &biff12_cell(0)));
        far.extend(biff12_record(0x0000, &biff12_row_header(1_048_575)));
        far.extend(biff12_record(0x0005, &biff12_cell(16_383)));
        far.extend(biff12_record(0x0092, &[]));
        let mut budget = ConvertBudget::new();
        let error =
            scan_xlsb_stream(&mut std::io::Cursor::new(&far), "sheet1", &mut budget).unwrap_err();
        assert!(
            error.to_string().contains("refuses huge dimensions"),
            "{error}"
        );

        // A small valid stream passes and commits its box to the total.
        let mut small = biff12_record(0x0094, &[0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0]);
        small.extend(biff12_record(0x0000, &biff12_row_header(0)));
        small.extend(biff12_record(0x0005, &biff12_cell(0)));
        small.extend(biff12_record(0x0092, &[]));
        let mut budget = ConvertBudget::new();
        scan_xlsb_stream(&mut std::io::Cursor::new(&small), "sheet1", &mut budget).unwrap();
    }

    #[test]
    fn xls_preflight_refuses_a_full_grid_dimensions_record() {
        // Minimal CFB with a Workbook stream carrying BOF + full-grid
        // DIMENSIONS + EOF: kilobytes on disk, refused before calamine's
        // open-time `Vec::reserve` on the DIMENSIONS box.
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("huge-grid.xls");
        let mut compound = cfb::create(&source).unwrap();
        {
            let mut stream = compound.create_stream("/Workbook").unwrap();
            stream.write_all(&[0x09, 0x08, 0x10, 0x00]).unwrap(); // BOF
            stream.write_all(&[0u8; 16]).unwrap();
            stream.write_all(&[0x00, 0x02, 0x0E, 0x00]).unwrap(); // DIMENSIONS
            stream.write_all(&0u32.to_le_bytes()).unwrap(); // rwMic
            stream.write_all(&65536u32.to_le_bytes()).unwrap(); // rwMac
            stream.write_all(&0u16.to_le_bytes()).unwrap(); // colMic
            stream.write_all(&256u16.to_le_bytes()).unwrap(); // colMac
            stream.write_all(&[0u8; 2]).unwrap();
            stream.write_all(&[0x0A, 0x00, 0x00, 0x00]).unwrap(); // EOF
        }
        drop(compound);
        // A minimal CFB is tens of kilobytes (sectors + FAT), still nothing
        // next to the gigabytes the DIMENSIONS box claims.
        assert!(std::fs::metadata(&source).unwrap().len() < 100_000);
        let target = dir.path().join("converted.xlsx");
        let started = Instant::now();
        assert_fast_budget_refusal(convert_to_xlsx(&source, &target), started);
        assert!(!target.exists());
    }
    #[test]
    fn refuses_ods_with_billions_of_empty_repeated_rows() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("empty-repeat.ods");
        write_zip_entries(
            &source,
            &ods_package(
                r#"<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Empty"><table:table-row table:number-rows-repeated="4294967295"/></table:table></office:spreadsheet></office:body></office:document-content>"#,
            ),
        );
        let target = dir.path().join("converted.xlsx");
        assert_fast_budget_refusal(convert_to_xlsx(&source, &target), Instant::now());
        assert!(!target.exists());
    }

    #[test]
    fn refuses_xls_stored_cells_outside_a_small_declared_dimension() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("understated.xls");
        let mut compound = cfb::create(&source).unwrap();
        {
            let mut stream = compound.create_stream("/Workbook").unwrap();
            stream.write_all(&[0x09, 0x08, 0x10, 0x00]).unwrap();
            stream.write_all(&[0u8; 16]).unwrap();
            for (row, col) in [(0u16, 0u16), (65535, 255)] {
                stream.write_all(&[0x03, 0x02, 0x0E, 0x00]).unwrap();
                stream.write_all(&row.to_le_bytes()).unwrap();
                stream.write_all(&col.to_le_bytes()).unwrap();
                stream.write_all(&[0u8; 10]).unwrap();
            }
            stream.write_all(&[0x0A, 0x00, 0x00, 0x00]).unwrap();
        }
        drop(compound);
        let target = dir.path().join("converted.xlsx");
        assert_fast_budget_refusal(convert_to_xlsx(&source, &target), Instant::now());
        assert!(!target.exists());
    }
}
