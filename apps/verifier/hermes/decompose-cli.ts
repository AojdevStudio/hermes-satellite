#!/usr/bin/env node
/**
 * File-based CLI wrapper for bridge-side decompose calls.
 *
 * Keep this as real TypeScript source so transcript/prompt content is passed as
 * data (input JSON file), never interpolated into an eval'd Node program.
 */

import { readFileSync } from "node:fs";
import Type from "typebox";
import { Parse } from "typebox/value";

import { decomposeTranscript } from "./decompose.js";
import { parseExportJsonl } from "./transcript.js";

interface DecomposeCliInput {
  transcriptJsonl?: string;
  originalPrompt?: string;
}

const DecomposeCliInputSchema = Type.Object({
  transcriptJsonl: Type.Optional(Type.String()),
  originalPrompt: Type.Optional(Type.String()),
});

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("usage: decompose-cli <input-json-path>");
}

const input: DecomposeCliInput = Parse(
  DecomposeCliInputSchema,
  JSON.parse(readFileSync(inputPath, "utf8")),
);
const transcript = parseExportJsonl(input.transcriptJsonl ?? "");
const output = decomposeTranscript({
  transcript,
  originalPrompt: input.originalPrompt ?? "",
});

console.log(JSON.stringify(output));
