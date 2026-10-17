//! Conservative OpenFormula to Excel translation. Unknown expressions retain
//! their cached values instead of producing invalid or misleading formulas.

const FUNCTIONS: &[&str] = &[
    "SUM",
    "AVERAGE",
    "MIN",
    "MAX",
    "COUNT",
    "COUNTA",
    "IF",
    "AND",
    "OR",
    "NOT",
    "ABS",
    "ROUND",
    "ROUNDDOWN",
    "ROUNDUP",
    "INT",
    "MOD",
    "SQRT",
    "POWER",
    "LEN",
    "LEFT",
    "RIGHT",
    "MID",
    "TRIM",
    "LOWER",
    "UPPER",
    "CONCATENATE",
];

/// XLS has 256 columns and 65,536 rows. Some BIFF area tokens decoded by
/// calamine include relative-address flags in their column numbers. Refuse
/// impossible references instead of saving formulas that point elsewhere.
pub(super) fn has_invalid_xls_refs(source: &str) -> bool {
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if matches!(chars[index], '\'' | '"') {
            let quote = chars[index];
            index += 1;
            while index < chars.len() {
                if chars[index] == quote {
                    index += 1;
                    if chars.get(index) != Some(&quote) {
                        break;
                    }
                }
                index += 1;
            }
            continue;
        }
        let start = index;
        if chars[index] == '$' {
            index += 1;
        }
        let column_start = index;
        let mut column = Some(0_u32);
        while chars.get(index).is_some_and(char::is_ascii_alphabetic) {
            column = column
                .and_then(|value| value.checked_mul(26))
                .and_then(|value| {
                    value.checked_add(chars[index].to_ascii_uppercase() as u32 - 'A' as u32 + 1)
                });
            index += 1;
        }
        if index == column_start {
            index = start + 1;
            continue;
        }
        if chars.get(index) == Some(&'$') {
            index += 1;
        }
        let row_start = index;
        let mut row = Some(0_u32);
        while chars.get(index).is_some_and(char::is_ascii_digit) {
            row = row
                .and_then(|value| value.checked_mul(10))
                .and_then(|value| value.checked_add(chars[index] as u32 - '0' as u32));
            index += 1;
        }
        let mut next = index;
        while chars.get(next).is_some_and(|value| value.is_whitespace()) {
            next += 1;
        }
        let identifier = |value: &char| value.is_alphanumeric() || matches!(value, '_' | '.');
        if index != row_start
            && (start == 0 || !identifier(&chars[start - 1]))
            && !chars.get(index).is_some_and(identifier)
            && !matches!(chars.get(next), Some('(' | '!'))
            && (column.is_none_or(|value| value == 0 || value > 256)
                || row.is_none_or(|value| value == 0 || value > 65_536))
        {
            return true;
        }
    }
    false
}

/// Named ranges and table/external references are absent from the converted
/// workbook. Keep their cached results instead of emitting broken references.
pub(super) fn has_nonportable_excel_refs(source: &str, names: &[String]) -> bool {
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if c == '"' || c == '\'' {
            let quote = c;
            index += 1;
            let mut closed = false;
            while index < chars.len() {
                if chars[index] == quote {
                    index += 1;
                    if chars.get(index) == Some(&quote) {
                        index += 1;
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            if !closed {
                return true;
            }
        } else if c == '[' {
            return true;
        } else if c.is_alphabetic() || c == '_' || c == '\\' {
            let start = index;
            while chars
                .get(index)
                .is_some_and(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '\\'))
            {
                index += 1;
            }
            let token: String = chars[start..index].iter().collect();
            let mut next = index;
            while chars.get(next).is_some_and(|c| c.is_whitespace()) {
                next += 1;
            }
            if !matches!(chars.get(next), Some('(' | '!'))
                && names.iter().any(|name| name.eq_ignore_ascii_case(&token))
            {
                return true;
            }
        } else {
            index += 1;
        }
    }
    false
}

pub(super) fn translate_ods(source: &str, sheets: &[String]) -> Option<String> {
    let source = source
        .strip_prefix("of:=")
        .or_else(|| source.strip_prefix("oooc:="))?;
    let chars: Vec<char> = source.chars().collect();
    let mut result = String::new();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        match character {
            '"' => {
                result.push('"');
                index += 1;
                let mut closed = false;
                while index < chars.len() {
                    let c = chars[index];
                    result.push(c);
                    index += 1;
                    if c == '"' {
                        if chars.get(index) == Some(&'"') {
                            result.push('"');
                            index += 1;
                        } else {
                            closed = true;
                            break;
                        }
                    }
                }
                if !closed {
                    return None;
                }
            }
            '[' => {
                let end = chars[index + 1..].iter().position(|c| *c == ']')? + index + 1;
                let reference: String = chars[index + 1..end].iter().collect();
                result.push_str(&translate_reference(&reference, sheets)?);
                index = end + 1;
            }
            ';' => {
                result.push(',');
                index += 1;
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = index;
                while chars
                    .get(index)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
                {
                    index += 1;
                }
                let token: String = chars[start..index].iter().collect();
                let upper = token.to_ascii_uppercase();
                let mut next = index;
                while chars.get(next).is_some_and(|c| c.is_whitespace()) {
                    next += 1;
                }
                if chars.get(next) == Some(&'(') {
                    if !FUNCTIONS.contains(&upper.as_str()) {
                        return None;
                    }
                } else if !matches!(upper.as_str(), "TRUE" | "FALSE") {
                    // Named ranges/expressions are not carried into the new package.
                    return None;
                }
                result.push_str(&upper);
            }
            c if c.is_ascii_digit() => {
                // Numeric literals, including exponent notation.
                let start = index;
                while chars
                    .get(index)
                    .is_some_and(|c| c.is_ascii_digit() || *c == '.')
                {
                    index += 1;
                }
                if chars.get(index).is_some_and(|c| *c == 'e' || *c == 'E') {
                    index += 1;
                    if chars.get(index).is_some_and(|c| *c == '+' || *c == '-') {
                        index += 1;
                    }
                    let exponent = index;
                    while chars.get(index).is_some_and(|c| c.is_ascii_digit()) {
                        index += 1;
                    }
                    if exponent == index {
                        return None;
                    }
                }
                let number: String = chars[start..index].iter().collect();
                if number.parse::<f64>().ok()?.is_finite() {
                    result.push_str(&number);
                } else {
                    return None;
                }
            }
            c if c.is_whitespace() || "+-*/^&%=<>(),.".contains(c) => {
                result.push(c);
                index += 1;
            }
            _ => return None,
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn translate_reference(reference: &str, sheets: &[String]) -> Option<String> {
    // Colons inside a quoted sheet name are legal; external and 3D references
    // need a richer importer and must not become local references accidentally.
    let mut quote = false;
    let mut split = None;
    for (index, c) in reference.char_indices() {
        if c == '\'' {
            quote = !quote;
        }
        if c == ':' && !quote {
            if split.is_some() {
                return None;
            }
            split = Some(index);
        }
    }
    if quote {
        return None;
    }
    let (first, second) = split.map_or((reference, None), |at| {
        (&reference[..at], Some(&reference[at + 1..]))
    });
    let (sheet, address) = reference_endpoint(first, sheets)?;
    let mut result = sheet
        .as_ref()
        .map_or(address.clone(), |name| format!("'{name}'!{address}"));
    if let Some(end) = second {
        let (end_sheet, end_address) = reference_endpoint(end, sheets)?;
        if end_sheet.is_some() && end_sheet != sheet {
            return None;
        }
        result.push(':');
        result.push_str(&end_address);
    }
    Some(result)
}

fn reference_endpoint(source: &str, sheets: &[String]) -> Option<(Option<String>, String)> {
    let dot = source.rfind('.')?;
    let sheet = source[..dot].strip_prefix('$').unwrap_or(&source[..dot]);
    let sheet = if sheet.is_empty() {
        None
    } else {
        let name = if sheet.starts_with('\'') && sheet.ends_with('\'') {
            sheet[1..sheet.len() - 1].replace("''", "'")
        } else {
            sheet.to_string()
        };
        if !sheets.contains(&name) {
            return None;
        }
        Some(name.replace('\'', "''"))
    };
    let address = &source[dot + 1..];
    let mut chars = address.chars().peekable();
    if chars.peek() == Some(&'$') {
        chars.next();
    }
    let mut column = 0usize;
    while chars.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
        column = column
            .checked_mul(26)?
            .checked_add(chars.next()?.to_ascii_uppercase() as usize - 'A' as usize + 1)?;
    }
    if column == 0 || column > 16_384 {
        return None;
    }
    if chars.peek() == Some(&'$') {
        chars.next();
    }
    let row: String = chars.collect();
    if !row.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let row = row.parse::<u32>().ok()?;
    if row == 0 || row > 1_048_576 {
        return None;
    }
    Some((sheet, address.to_ascii_uppercase()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_impossible_biff_references_without_mistaking_strings_or_functions() {
        for source in ["SUM($USN$2:$USN$4)", "IW1+1", "A65537", "A0"] {
            assert!(has_invalid_xls_refs(source), "{source}");
        }
        for source in [
            "SUM($B$2:$B$4)",
            "IV65536",
            "LOG10(A1)",
            "IF(A1=1,\"USN2\",0)",
            "'USN2'!B1",
            "USN2!A1",
        ] {
            assert!(!has_invalid_xls_refs(source), "{source}");
        }
    }
    #[test]
    fn translates_references_arguments_and_strings() {
        let sheets = vec!["Data".into(), "Other Sheet".into()];
        assert_eq!(
            translate_ods("of:=SUM([.A1:.B2];['Other Sheet'.$C$1];1E-3)", &sheets).as_deref(),
            Some("SUM(A1:B2,'Other Sheet'!$C$1,1E-3)")
        );
        assert_eq!(
            translate_ods("of:=IF([.A1]>0;\"a;[.B1]\";\"b\")", &sheets).as_deref(),
            Some("IF(A1>0,\"a;[.B1]\",\"b\")")
        );
    }
    #[test]
    fn refuses_unsupported_and_external_expressions() {
        let sheets = vec!["Data".into()];
        for formula in [
            "of:=UNSUPPORTED([.A1])",
            "of:=named_range*2",
            "of:=[Missing.A1]",
            "of:=['file:///tmp/data.ods'#$Data.A1]",
            "of:={1;2|3;4}",
            "of:=[.A0]",
        ] {
            assert!(translate_ods(formula, &sheets).is_none(), "{formula}");
        }
    }

    #[test]
    fn detects_references_to_dropped_excel_metadata() {
        let names = vec!["TaxRate".into()];
        assert!(has_nonportable_excel_refs("A1*TaxRate", &names));
        assert!(has_nonportable_excel_refs("SUM(Table1[Amount])", &names));
        assert!(has_nonportable_excel_refs("[Book.xlsx]Data!A1", &names));
        assert!(!has_nonportable_excel_refs(
            "IF(A1>0,\"TaxRate[quoted]\",0)",
            &names
        ));
        assert!(!has_nonportable_excel_refs(
            "'Other Sheet'!A1+SUM(A1:B1)",
            &names
        ));
    }
}
