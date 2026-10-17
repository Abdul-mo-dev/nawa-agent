The binary `.dot`, `.pps`, and `.pot` files here are generated from the existing
`packages/file-parse/tests/fixtures/legacy-sample.doc` and `.ppt` fixtures using
LibreOffice's Word 97-2003 template, PowerPoint AutoPlay, and PowerPoint template
export filters. They exercise genuine template/show flags, rather than renamed
document files. Run `node generate.mjs` from any directory with LibreOffice
installed (or set `NAWA_LIBREOFFICE_PATH`) to regenerate them.
