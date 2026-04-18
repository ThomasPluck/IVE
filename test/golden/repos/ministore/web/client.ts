import { z } from "zod";
import * as fs from "node:fs";

const CartItem = z.object({
  sku: z.string(),
  qty: z.number().int().positive(),
});

export function loadCart(path: string): unknown {
  const raw = fs.readFileSync(path, "utf8");
  return JSON.parse(raw);
}

export function validate(input: unknown) {
  return CartItem.array().parse(input);
}
