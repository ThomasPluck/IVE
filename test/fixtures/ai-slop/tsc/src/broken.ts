export function add(x: number, y: number): number {
  return x + y;
}

// tsc will flag: wrong argument type.
const total: number = add(1, "two");

// tsc will flag: return type mismatch.
export function wrong(): number {
  return "not a number";
}

export function noop(): void {
  // This will flag because number isn't assignable to string.
  const s: string = 123;
  void s;
}

console.log(total, wrong());
