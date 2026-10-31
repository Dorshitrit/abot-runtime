import { expect, test } from "vitest";
import { basketSourceNameMatchRank } from "../information-basket/source-name-matching.js";

test.each([
  ["whole query", "Alex Sample - CV.docx", "Alex Sample - CV.docx"],
  ["inside a sentence", "נא למצוא את Alex Sample - CV.docx", "Alex Sample - CV.docx"],
  ["case", "Please find ALEX SAMPLE - cv.DOCX", "Alex Sample - CV.docx"],
  ["whitespace", "Check Alex\tSample  -\nCV.docx", "Alex Sample - CV.docx"],
  ["canonical Unicode", "Find Re\u0301sume\u0301.pdf", "Résumé.pdf"],
  ["quotes", 'Find "report.pdf", please', "report.pdf"],
  ["curly quotes", "Find “report.pdf”", "report.pdf"],
  ["parentheses", "Find (report.pdf)", "report.pdf"],
  ["sentence end", "Find report.pdf.", "report.pdf"],
  ["ellipsis", "Find report.pdf... please", "report.pdf"],
  ["Hebrew name", "מצא את קורות חיים.pdf.", "קורות חיים.pdf"],
  ["literal punctuation", "Find notes [draft]+(2).md", "notes [draft]+(2).md"],
  ["later full occurrence", "old-report.pdf.bak; report.pdf", "report.pdf"],
])("matches the complete registered source name: %s", (_label, query, name) => {
  expect(basketSourceNameMatchRank(query, name)).toBe(2);
});

test.each([
  ["greeting", "היי", "report.pdf"],
  ["empty query", "", "report.pdf"],
  ["empty name", "report.pdf", ""],
  ["blank name", "report.pdf", " \t "],
  ["stem only", "Find report", "report.pdf"],
  ["different extension", "Find report.docx", "report.pdf"],
  ["word prefix", "Find myreport.pdf", "report.pdf"],
  ["hyphen prefix", "Find old-report.pdf", "report.pdf"],
  ["underscore prefix", "Find old_report.pdf", "report.pdf"],
  ["extension suffix", "Find report.pdf.bak", "report.pdf"],
  ["hyphen suffix", "Find report.pdf-old", "report.pdf"],
  ["word suffix", "Find report.pdfbackup", "report.pdf"],
  ["Hebrew prefix", "מצא דוחreport.pdf", "report.pdf"],
  ["literal dot", "Find reportXpdf", "report.pdf"],
])("rejects partial or unrelated source names: %s", (_label, query, name) => {
  expect(basketSourceNameMatchRank(query, name)).toBe(0);
});


test.each([
  ["requested name", "חפש Alex Sample במסמכים", "Alex Sample - CV.docx"],
  ["inside a name", "Find Sample CV", "Alex Sample - CV.docx"],
  ["Hebrew words", "מצא קורות חיים בבקשה", "דוגמה - קורות חיים.pdf"],
  ["file separators", "Find quarterly report", "2026_quarterly-report.pdf"],
  ["query separators", "Find quarterly-report", "2026 quarterly report.pdf"],
  ["preceding separator", "Find 2026_quarterly_report", "quarterly report.pdf"],
  ["following separator", "Find quarterly-report-2026", "quarterly report.pdf"],
  ["case and whitespace", "Find ALEX\tSAMPLE", "Alex Sample - CV.docx"],
  ["canonical Unicode", "Find Re\u0301sume\u0301 final", "Résumé final 2026.pdf"],
])("matches a complete word sequence: %s", (_label, query, name) => {
  expect(basketSourceNameMatchRank(query, name)).toBe(1);
});

test.each([
  ["greeting", "היי", "Alex Sample - CV.docx"],
  ["single word", "Find Alex", "Alex Sample - CV.docx"],
  ["reordered words", "Find Sample Alex", "Alex Sample - CV.docx"],
  ["nonconsecutive words", "Find Alex CV", "Alex Sample - CV.docx"],
  ["word prefix", "Find Malex Sample", "Alex Sample - CV.docx"],
  ["word suffix", "Find Alex Sampleson", "Alex Sample - CV.docx"],
  ["sentence boundary", "Find Alex. Sample", "Alex Sample - CV.docx"],
  ["extension is not a name word", "Find report pdf", "report.pdf"],
  ["different explicit extension", "Find quarterly report.docx", "quarterly report.pdf"],
])("does not promote unrelated or incomplete word sequences: %s", (_label, query, name) => {
  expect(basketSourceNameMatchRank(query, name)).toBe(0);
});
