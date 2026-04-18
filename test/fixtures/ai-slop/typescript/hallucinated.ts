import { readFile } from "node:fs/promises";
import pino from "pino";
import { makeImaginaryThing } from "imaginary-package"; // not a real package

const logger = pino();

export async function loadConfig(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  if (!text) {
    if (process.env.STRICT === "1") {
      throw new Error("empty config");
    }
    return {};
  }
  return JSON.parse(text);
}

export const makeThing = () => makeImaginaryThing();
