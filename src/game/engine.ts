export const ROWS = 7;
export const COLS = 7;
export const ANIMALS = ["puppy", "cat", "rabbit", "bear", "panda", "chick"] as const;
export type Animal = (typeof ANIMALS)[number];
export type Special = "none" | "smile" | "rainbow" | "bomb" | "coin" | "time";
export type RandomSource = () => number;

export interface Cell {
  id: number;
  animal: Animal;
  special: Special;
}

let nextId = 1;
export const newId = () => nextId++;

export const rand = <T>(arr: readonly T[], random: RandomSource = Math.random): T =>
  arr[Math.floor(random() * arr.length)];

export function makeCell(animal?: Animal, special: Special = "none", random = Math.random): Cell {
  return { id: newId(), animal: animal ?? rand(ANIMALS, random), special };
}

export function createBoard(random: RandomSource = Math.random): Cell[][] {
  let board: Cell[][];
  do {
    board = Array.from({ length: ROWS }, () =>
      Array.from({ length: COLS }, () => makeCell(undefined, "none", random)),
    );
    // strip starting matches
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        while (
          (c >= 2 &&
            board[r][c].animal === board[r][c - 1].animal &&
            board[r][c].animal === board[r][c - 2].animal) ||
          (r >= 2 &&
            board[r][c].animal === board[r - 1][c].animal &&
            board[r][c].animal === board[r - 2][c].animal)
        ) {
          board[r][c] = makeCell(undefined, "none", random);
        }
      }
    }
  } while (!hasAnyMove(board));
  return board;
}

export function findMatches(board: Cell[][]): boolean[][] {
  const m = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  // horizontal
  for (let r = 0; r < ROWS; r++) {
    let run = 1;
    for (let c = 1; c <= COLS; c++) {
      if (c < COLS && board[r][c].animal === board[r][c - 1].animal) {
        run++;
      } else {
        if (run >= 3) for (let k = 0; k < run; k++) m[r][c - 1 - k] = true;
        run = 1;
      }
    }
  }
  // vertical
  for (let c = 0; c < COLS; c++) {
    let run = 1;
    for (let r = 1; r <= ROWS; r++) {
      if (r < ROWS && board[r][c].animal === board[r - 1][c].animal) {
        run++;
      } else {
        if (run >= 3) for (let k = 0; k < run; k++) m[r - 1 - k][c] = true;
        run = 1;
      }
    }
  }
  return m;
}

export function hasAnyMatch(board: Cell[][]): boolean {
  const m = findMatches(board);
  return m.some((row) => row.some(Boolean));
}

export function swap(board: Cell[][], a: [number, number], b: [number, number]) {
  const t = board[a[0]][a[1]];
  board[a[0]][a[1]] = board[b[0]][b[1]];
  board[b[0]][b[1]] = t;
}

export function adjacent(a: [number, number], b: [number, number]) {
  const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  return d === 1;
}

export function findHint(board: Cell[][]): [number, number] | null {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
      ]) {
        const nr = r + dr,
          nc = c + dc;
        if (nr >= ROWS || nc >= COLS) continue;
        const cp = board.map((row) => row.slice());
        swap(cp, [r, c], [nr, nc]);
        if (hasAnyMatch(cp)) return [r, c];
      }
    }
  }
  return null;
}

export function hasAnyMove(board: Cell[][]): boolean {
  return findHint(board) !== null;
}

/** Apply gravity + refill. Returns the new board. */
export function collapseAndRefill(
  board: Cell[][],
  cleared: boolean[][],
  random: RandomSource = Math.random,
): Cell[][] {
  const nb = board.map((row) => row.slice());
  for (let c = 0; c < COLS; c++) {
    const col: Cell[] = [];
    for (let r = ROWS - 1; r >= 0; r--) {
      if (!cleared[r][c]) col.push(nb[r][c]);
    }
    while (col.length < ROWS) col.push(makeCell(undefined, "none", random));
    for (let r = ROWS - 1, i = 0; r >= 0; r--, i++) {
      nb[r][c] = col[i];
    }
  }
  return nb;
}

/** Expand cleared cells based on special blocks they touch. */
export function expandSpecials(
  board: Cell[][],
  baseCleared: boolean[][],
  fever: boolean,
  random: RandomSource = Math.random,
): { cleared: boolean[][]; specialsTriggered: number; coinHits: number; timeHits: number } {
  const cleared = baseCleared.map((row) => row.slice());
  let specialsTriggered = 0;
  let coinHits = 0;
  let timeHits = 0;
  // iterate until stable
  let changed = true;
  const processed = new Set<number>();
  while (changed) {
    changed = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!cleared[r][c]) continue;
        const cell = board[r][c];
        if (processed.has(cell.id)) continue;
        processed.add(cell.id);
        if (cell.special === "smile") {
          specialsTriggered++;
          for (let dr = -1; dr <= 1; dr++)
            for (let dc = -1; dc <= 1; dc++) {
              const nr = r + dr,
                nc = c + dc;
              if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && !cleared[nr][nc]) {
                cleared[nr][nc] = true;
                changed = true;
              }
            }
        } else if (cell.special === "rainbow") {
          specialsTriggered++;
          const target = rand(ANIMALS, random);
          for (let nr = 0; nr < ROWS; nr++)
            for (let nc = 0; nc < COLS; nc++) {
              if (!cleared[nr][nc] && board[nr][nc].animal === target) {
                cleared[nr][nc] = true;
                changed = true;
              }
            }
        } else if (cell.special === "bomb") {
          specialsTriggered++;
          for (let nr = 0; nr < ROWS; nr++)
            if (!cleared[nr][c]) {
              cleared[nr][c] = true;
              changed = true;
            }
          for (let nc = 0; nc < COLS; nc++)
            if (!cleared[ROWS - 1][nc]) {
              cleared[ROWS - 1][nc] = true;
              changed = true;
            }
        } else if (cell.special === "coin") {
          coinHits++;
        } else if (cell.special === "time") {
          timeHits++;
        }
      }
    }
  }
  // fever bonus: cardinal neighbors
  if (fever) {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        if (baseCleared[r][c]) {
          for (const [dr, dc] of [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ]) {
            const nr = r + dr,
              nc = c + dc;
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) cleared[nr][nc] = true;
          }
        }
      }
  }
  return { cleared, specialsTriggered, coinHits, timeHits };
}

/** Decide if a match group should produce a special block. */
export function specialFromMatch(size: number): Special {
  if (size >= 5) return "rainbow";
  if (size === 4) return "smile";
  return "none";
}

/** Find connected match groups in cleared map. */
export function matchGroups(
  board: Cell[][],
  cleared: boolean[][],
): { cells: [number, number][]; animal: Animal }[] {
  const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const groups: { cells: [number, number][]; animal: Animal }[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!cleared[r][c] || visited[r][c]) continue;
      const animal = board[r][c].animal;
      const stack: [number, number][] = [[r, c]];
      const cells: [number, number][] = [];
      while (stack.length) {
        const [cr, cc] = stack.pop()!;
        if (cr < 0 || cr >= ROWS || cc < 0 || cc >= COLS) continue;
        if (visited[cr][cc] || !cleared[cr][cc]) continue;
        if (board[cr][cc].animal !== animal) continue;
        visited[cr][cc] = true;
        cells.push([cr, cc]);
        stack.push([cr + 1, cc], [cr - 1, cc], [cr, cc + 1], [cr, cc - 1]);
      }
      if (cells.length >= 3) groups.push({ cells, animal });
    }
  }
  return groups;
}
