export * from './workbook.js';
export * from './detect.js';
export * from './writeback.js';
// `zip.ts` and `xml.ts` are the reader's internals. Their refusals surface as
// `WorkbookRefusal`, so a caller never needs to know a spreadsheet is a zip.
export { ZipRefusal, DEFAULT_ZIP_LIMITS, type ZipLimits } from './zip.js';
export { XmlRefusal } from './xml.js';
