import { defineGroup } from "../define.js";
import { waitApp } from "./app.js";
import { waitBoot } from "./boot.js";
import { waitLog } from "./log.js";

export const wait = defineGroup({
  name: "wait",
  summary: "Deadline-bounded waits that report how long they waited",
  subcommands: [waitBoot, waitApp, waitLog],
});
