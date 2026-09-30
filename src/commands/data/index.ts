import { defineGroup } from "../define.js";
import { dataDb } from "./db.js";

export const data = defineGroup({
  name: "data",
  summary: "Read app data through run-as",
  subcommands: [dataDb],
});
