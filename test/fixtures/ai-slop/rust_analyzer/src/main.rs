fn add(x: i32, y: i32) -> i32 {
    x + y
}

fn main() {
    // rust-analyzer flags this: mismatched types, expected i32, found &str.
    let _total: i32 = add(1, "two");
}
