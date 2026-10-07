// The decide-only run #175's acceptance criteria asks for, pinned to the
// real case it reports: whether near-agencies#167 would be held back right
// now (scripts/decide-source.mjs holds the check itself, reusable for any
// source issue).
//
//   node scratch-decide-167.mjs
import { decide } from "./scripts/decide-source.mjs";

await decide("MultiAgency/near-agencies#167");
