use std::collections::HashMap;
use serde::Serialize;
use imaginary_crate::InventedThing;  // not in Cargo.toml

#[derive(Serialize)]
struct Thing {
    field: u32,
}

fn compute(x: u32, y: u32) -> u32 {
    if x == 0 {
        return y;
    }
    match y {
        0 => x,
        _ => {
            if x > y {
                x - y
            } else {
                y - x
            }
        }
    }
}

fn main() {
    let m: HashMap<String, u32> = HashMap::new();
    println!("{}", compute(1, 2));
    drop(m);
    let _: InventedThing = todo!();
}
