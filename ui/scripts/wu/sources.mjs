// The Wu library: which of H. Wu's freely posted drafts stand in for which of his books, and where the pipeline
// keeps its work. Everything lives under ui/data/sources/wu/ (ignored by git, like the rest of ui/data):
//
//   _raw/<doc>.pdf            downloads (untrusted: only pdftotext/pdfinfo read them)
//   manifest.json             {docs: {<doc>: {url, title, book, sha256, pages, words}}}
//   <doc>/pages/NNNN.txt      pdftotext -layout, one file per PDF page
//   split.json                the survey: curricula and the chapters (doc + PDF page range) each one is built from
//   chapters/<cur>/<n>.json   one chapter's extracted nodes and edges
//   <cur>/content.json        merged content DAG for a curriculum (wu_dag.json shape)
//   <cur>/methods.json        merged methods DAG
//
// The six published AMS books are not free. The drafts below are what Wu posts at math.berkeley.edu/~wu; drop a
// PDF into _raw/ and add a row here to extract a book you own.
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WU_DIR = process.env.HW_WU_DIR || path.join(process.env.HW_DATA || path.join(UI, "data"), "sources", "wu");
export const BASE_URL = "https://math.berkeley.edu/~wu/";

export const BOOKS = {
  unesm: "Understanding Numbers in Elementary School Mathematics (2011)",
  prealg: "Teaching School Mathematics: Pre-Algebra (2016)",
  alg: "Teaching School Mathematics: Algebra (2016)",
  rnle: "Rational Numbers to Linear Equations (2020)",
  ag: "Algebra and Geometry (2020)",
  pcb: "Pre-Calculus, Calculus, and Beyond (2020)",
};

// doc id (file name without .pdf) -> the book it drafts, and what it is.
export const DOCS = {
  EMI1c: { book: "unesm", title: "Chapter 1: Whole Numbers (draft, 2002)" },
  EMI2a: { book: "unesm", title: "Chapter 2: Fractions (draft, 2002)" },
  fractions1998: { book: "unesm", title: "Teaching fractions in elementary school: a manual for teachers (1998)" },
  "CCSS-Fractions_1": { book: "unesm", title: "Teaching Fractions According to the Common Core Standards (2014)" },
  "Pre-Algebra": { book: "prealg", title: "Pre-Algebra (draft of textbook for teachers of grades 6-8, 2011)" },
  Algebrasummary: { book: "alg", title: "Introduction to School Algebra (draft, 2010)" },
  RNLE_polygon: { book: "rnle", title: "A characterization of regular polygons (RNLE supplement, 2020)" },
  RNLE_similarity: { book: "rnle", title: "A theorem about similarity (RNLE supplement, 2020)" },
  "CCSS-Geometry_1": { book: "ag", title: "Teaching Geometry in Grade 8 and High School According to the Common Core Standards (2013)" },
  Progressions_Geometry: { book: "ag", title: "Teaching Geometry According to the Common Core Standards (2013)" },
  Lisbon2010_1: { book: "ag", title: "Euclid and high school geometry (2010)" },
  supplement: { book: "pcb", title: "Topics in Pre-Calculus: Functions, graphs, and basic mensuration formulas (2003)" },
};

export const p = (...xs) => path.join(WU_DIR, ...xs);
export const pageFile = (doc, n) => p(doc, "pages", `${String(n).padStart(4, "0")}.txt`);
