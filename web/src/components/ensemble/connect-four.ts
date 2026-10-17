// Connect Four rules for the hero demo. A board is just its list of pieces:
// row 0 is the bottom, so a piece's row is how many pieces sit below it.

export type Player = 0 | 1;

export interface Piece {
  id: number;
  col: number;
  row: number;
  player: Player;
}

/** What the group has asked for so far. Each chat request changes one of these. */
export interface GameConfig {
  cols: number;
  rows: number;
  colors: [string, string];
  names: [string, string];
  board: string;
  winGlow: boolean;
}

/** The row a piece dropped in `col` lands on, or -1 if the column is full. */
export function landingRow(pieces: Piece[], col: number, rows: number): number {
  const used = pieces.filter((p) => p.col === col).length;
  return used < rows ? used : -1;
}

/** Ids of the first four-in-a-row, or null. */
export function findWin(pieces: Piece[]): number[] | null {
  const at = new Map(pieces.map((p) => [`${p.col},${p.row}`, p]));
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ] as const;
  for (const p of pieces) {
    for (const [dc, dr] of directions) {
      const line = [p];
      for (let k = 1; k < 4; k++) {
        const next = at.get(`${p.col + dc * k},${p.row + dr * k}`);
        if (!next || next.player !== p.player) break;
        line.push(next);
      }
      if (line.length === 4) return line.map((q) => q.id);
    }
  }
  return null;
}

export const turnOf = (pieces: Piece[]): Player => (pieces.length % 2) as Player;
