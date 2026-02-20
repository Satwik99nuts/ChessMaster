const boardElement = document.getElementById("chessboard");
const statusElement = document.getElementById("game-status");
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
const promotionOptions = document.getElementById("promotion-options");
const modalCloseBtn = document.getElementById("modal-close");

// Game State
let board = [];
let turn = "white"; // 'white' or 'black'
let selectedSquare = null;
let gameMode = "pvp"; // 'pvp' or 'solo'
let grabbedPiece = null;
let capturedPieces = { w: [], b: [] }; // white and black captured pieces
let moveCount = 0; // Full move counter
let halfMoveClock = 0; // Half-move clock for 50-move rule / FEN

// Stockfish Engine
let stockfishWorker = null;
let stockfishReady = false;
let useStockfish = false; // Whether to use Stockfish or fallback minimax

async function initStockfish() {
  try {
    // Fetch stockfish.js as blob to bypass CORS restrictions on Web Workers
    const response = await fetch(
      "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js",
    );
    const blob = await response.blob();
    const blobURL = URL.createObjectURL(blob);
    stockfishWorker = new Worker(blobURL);
    stockfishWorker.onmessage = (e) => {
      const line = e.data;
      if (line === "uciok") {
        stockfishReady = true;
        useStockfish = true;
        console.log("Stockfish engine loaded successfully!");
        updateEngineStatus(true);
      }
    };
    stockfishWorker.onerror = () => {
      console.warn("Stockfish worker error, using built-in AI");
      useStockfish = false;
      updateEngineStatus(false);
    };
    stockfishWorker.postMessage("uci");
  } catch (err) {
    console.warn("Stockfish failed to load, using built-in AI:", err);
    useStockfish = false;
    updateEngineStatus(false);
  }
}

function updateEngineStatus(loaded) {
  const el = document.getElementById("engine-status");
  if (el) {
    el.innerText = loaded ? "⚡ Stockfish" : "🧠 Built-in AI";
    el.className = "engine-status " + (loaded ? "online" : "offline");
  }
}

// Convert board state to FEN notation
function boardToFEN() {
  let fen = "";
  for (let r = 0; r < 8; r++) {
    let emptyCount = 0;
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) {
        emptyCount++;
      } else {
        if (emptyCount > 0) {
          fen += emptyCount;
          emptyCount = 0;
        }
        const pieceMap = { p: "p", r: "r", n: "n", b: "b", q: "q", k: "k" };
        const ch = pieceMap[piece[1]];
        fen += piece[0] === "w" ? ch.toUpperCase() : ch;
      }
    }
    if (emptyCount > 0) fen += emptyCount;
    if (r < 7) fen += "/";
  }

  // Active color
  fen += " " + (turn === "white" ? "w" : "b");

  // Castling availability
  let castling = "";
  if (castlingRights.white.kingSide) castling += "K";
  if (castlingRights.white.queenSide) castling += "Q";
  if (castlingRights.black.kingSide) castling += "k";
  if (castlingRights.black.queenSide) castling += "q";
  fen += " " + (castling || "-");

  // En passant target square
  if (enPassantTarget) {
    const file = String.fromCharCode(97 + enPassantTarget.c);
    const rank = 8 - enPassantTarget.r;
    fen += " " + file + rank;
  } else {
    fen += " -";
  }

  // Half-move clock and full move number
  fen += " " + halfMoveClock;
  fen += " " + Math.max(1, moveCount);

  return fen;
}

// Convert UCI move string (e.g. "e2e4") to {from, to} coordinates
function uciToCoords(uciMove) {
  const fromC = uciMove.charCodeAt(0) - 97;
  const fromR = 8 - parseInt(uciMove[1]);
  const toC = uciMove.charCodeAt(2) - 97;
  const toR = 8 - parseInt(uciMove[3]);
  const promotion = uciMove.length > 4 ? uciMove[4] : null;
  return { from: { r: fromR, c: fromC }, to: { r: toR, c: toC }, promotion };
}

// Ask Stockfish for a move/hint and return a Promise
function askStockfish(fen, depthLimit, skillLevel) {
  return new Promise((resolve, reject) => {
    if (!stockfishWorker || !stockfishReady) {
      reject("Stockfish not ready");
      return;
    }

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject("Stockfish timeout");
      }
    }, 10000);

    const handler = (e) => {
      const line = e.data;
      if (typeof line === "string" && line.startsWith("bestmove")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          stockfishWorker.removeEventListener("message", handler);
          const parts = line.split(" ");
          resolve(parts[1]); // e.g. "e2e4"
        }
      }
    };
    stockfishWorker.addEventListener("message", handler);

    stockfishWorker.postMessage("ucinewgame");
    stockfishWorker.postMessage(
      `setoption name Skill Level value ${skillLevel}`,
    );
    stockfishWorker.postMessage(`position fen ${fen}`);
    stockfishWorker.postMessage(`go depth ${depthLimit}`);
  });
}

// Hint system
let hintSquares = null; // { from: {r, c}, to: {r, c} }

function clearHints() {
  hintSquares = null;
  document
    .querySelectorAll(".hint-from, .hint-to, .hint-arrow")
    .forEach((el) => {
      el.classList.remove("hint-from", "hint-to");
      if (el.classList.contains("hint-arrow")) el.remove();
    });
}

async function getHint() {
  if (isGameOver) return;
  clearHints();

  const hintBtn = document.getElementById("btn-hint");
  if (hintBtn) {
    hintBtn.disabled = true;
    hintBtn.innerText = "🔍 Analyzing...";
  }

  try {
    let fromR, fromC, toR, toC;

    if (useStockfish && stockfishReady) {
      const fen = boardToFEN();
      const uciMove = await askStockfish(fen, 15, 20); // Max strength for best hint
      const coords = uciToCoords(uciMove);
      fromR = coords.from.r;
      fromC = coords.from.c;
      toR = coords.to.r;
      toC = coords.to.c;
    } else {
      // Fallback: use built-in minimax engine at max depth for the BEST move
      const moves = getLegalMoves(turn);
      if (moves.length === 0) return;

      const isBlack = turn === "black";
      let bestMove = moves[0];
      let bestScore = isBlack ? -Infinity : Infinity;

      for (const m of moves) {
        const newBoard = board.map((row) => [...row]);
        const newCR = JSON.parse(JSON.stringify(castlingRights));
        let newEP = null;
        const fromPiece = newBoard[m.from.r][m.from.c];
        newBoard[m.to.r][m.to.c] = fromPiece;
        newBoard[m.from.r][m.from.c] = null;

        if (m.special === "enpassant") newBoard[m.from.r][m.to.c] = null;
        if (m.special === "castle-ks") {
          newBoard[m.from.r][5] = newBoard[m.from.r][7];
          newBoard[m.from.r][7] = null;
        }
        if (m.special === "castle-qs") {
          newBoard[m.from.r][3] = newBoard[m.from.r][0];
          newBoard[m.from.r][0] = null;
        }
        if (m.special === "double-push")
          newEP = { r: (m.from.r + m.to.r) / 2, c: m.from.c };
        if (fromPiece[1] === "p" && (m.to.r === 0 || m.to.r === 7)) {
          newBoard[m.to.r][m.to.c] = fromPiece[0] + "q";
        }

        // Use minimax at depth 3 for a strong hint
        const score = minimax(
          newBoard,
          3,
          -Infinity,
          Infinity,
          isBlack ? false : true, // Next player after current
          isBlack ? "white" : "black",
          newCR,
          newEP,
        );

        if (isBlack) {
          if (score > bestScore) {
            bestScore = score;
            bestMove = m;
          }
        } else {
          if (score < bestScore) {
            bestScore = score;
            bestMove = m;
          }
        }
      }

      fromR = bestMove.from.r;
      fromC = bestMove.from.c;
      toR = bestMove.to.r;
      toC = bestMove.to.c;
    }

    // Highlight hint squares
    hintSquares = { from: { r: fromR, c: fromC }, to: { r: toR, c: toC } };
    const fromSq = document.getElementById(`sq-${fromR}-${fromC}`);
    const toSq = document.getElementById(`sq-${toR}-${toC}`);
    if (fromSq) fromSq.classList.add("hint-from");
    if (toSq) toSq.classList.add("hint-to");
  } catch (err) {
    console.warn("Hint failed:", err);
  } finally {
    if (hintBtn) {
      hintBtn.disabled = false;
      hintBtn.innerText = "💡 Hint";
    }
  }
}

// Initialize Stockfish on page load
initStockfish();

// Pieces
const PIECES = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

function initGame() {
  isGameOver = false;
  turn = "white";
  castlingRights = {
    white: { kingSide: true, queenSide: true },
    black: { kingSide: true, queenSide: true },
  };
  enPassantTarget = null;
  selectedSquare = null;
  pendingPromotion = null;
  capturedPieces = { w: [], b: [] };
  moveCount = 1;
  halfMoveClock = 0;
  statusElement.innerText = "White's Turn";

  clearHints();
  updateCapturedUI();

  // Initial Board Setup
  board = [
    ["br", "bn", "bb", "bq", "bk", "bb", "bn", "br"],
    ["bp", "bp", "bp", "bp", "bp", "bp", "bp", "bp"],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ["wp", "wp", "wp", "wp", "wp", "wp", "wp", "wp"],
    ["wr", "wn", "wb", "wq", "wk", "wb", "wn", "wr"],
  ];

  renderBoard();
}

function renderBoard() {
  boardElement.innerHTML = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = document.createElement("div");
      square.classList.add("square");
      square.classList.add((row + col) % 2 === 0 ? "light" : "dark");
      square.dataset.row = row;
      square.dataset.col = col;
      square.id = `sq-${row}-${col}`;

      const pieceCode = board[row][col];

      // Add Coordinates
      if (col === 0) {
        const rank = document.createElement("div");
        rank.classList.add("coordinate", "rank");
        rank.innerText = 8 - row;
        square.appendChild(rank);
      }
      if (row === 7) {
        const file = document.createElement("div");
        file.classList.add("coordinate", "file");
        file.innerText = String.fromCharCode(97 + col);
        square.appendChild(file);
      }

      if (pieceCode) {
        const piece = document.createElement("div");
        piece.classList.add("piece");
        piece.classList.add(pieceCode.startsWith("w") ? "white" : "black");
        piece.innerText = PIECES[pieceCode[0]][pieceCode[1]];

        piece.draggable = true;
        piece.dataset.row = row;
        piece.dataset.col = col;

        piece.addEventListener("dragstart", handleDragStart);
        square.appendChild(piece);
      }

      square.addEventListener("dragover", handleDragOver);
      square.addEventListener("drop", handleDrop);
      square.addEventListener("click", handleSquareClick);

      boardElement.appendChild(square);
    }
  }
}

// --- MOVE LOGIC ---

function getPseudoLegalMoves(r, c, piece) {
  const moves = [];
  const color = piece[0];
  const type = piece[1];
  const enemyColor = color === "w" ? "b" : "w";
  const direction = color === "w" ? -1 : 1;

  const addMove = (tr, tc, isCapture, special = null) => {
    moves.push({ from: { r, c }, to: { r: tr, c: tc }, special });
  };

  if (type === "p") {
    if (isValidSquare(r + direction, c) && !board[r + direction][c]) {
      addMove(r + direction, c, false);
      if ((color === "w" && r === 6) || (color === "b" && r === 1)) {
        if (
          isValidSquare(r + direction * 2, c) &&
          !board[r + direction * 2][c]
        ) {
          addMove(r + direction * 2, c, false, "double-push");
        }
      }
    }
    [
      [r + direction, c - 1],
      [r + direction, c + 1],
    ].forEach(([tr, tc]) => {
      if (isValidSquare(tr, tc)) {
        const target = board[tr][tc];
        if (target && target.startsWith(enemyColor)) addMove(tr, tc, true);
        if (
          enPassantTarget &&
          tr === enPassantTarget.r &&
          tc === enPassantTarget.c
        ) {
          addMove(tr, tc, true, "enpassant");
        }
      }
    });
  } else if (type === "n") {
    const offsets = [
      [-2, -1],
      [-2, 1],
      [-1, -2],
      [-1, 2],
      [1, -2],
      [1, 2],
      [2, -1],
      [2, 1],
    ];
    for (const [dr, dc] of offsets) {
      const tr = r + dr,
        tc = c + dc;
      if (isValidSquare(tr, tc)) {
        const target = board[tr][tc];
        if (!target || target.startsWith(enemyColor)) addMove(tr, tc, !!target);
      }
    }
  } else if (type === "k") {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const tr = r + dr,
          tc = c + dc;
        if (isValidSquare(tr, tc)) {
          const target = board[tr][tc];
          if (!target || target.startsWith(enemyColor))
            addMove(tr, tc, !!target);
        }
      }
    }
    // Castling logic placeholder - fully checked in isMoveLegal mostly
    if (canCastle(color, "kingSide")) {
      if (!board[r][c + 1] && !board[r][c + 2])
        addMove(r, c + 2, false, "castle-ks");
    }
    if (canCastle(color, "queenSide")) {
      if (!board[r][c - 1] && !board[r][c - 2] && !board[r][c - 3])
        addMove(r, c - 2, false, "castle-qs");
    }
  } else {
    // Sliding
    const directions = [];
    if (type === "r" || type === "q")
      directions.push([0, 1], [0, -1], [1, 0], [-1, 0]);
    if (type === "b" || type === "q")
      directions.push([1, 1], [1, -1], [-1, 1], [-1, -1]);

    for (const [dr, dc] of directions) {
      let tr = r + dr,
        tc = c + dc;
      while (isValidSquare(tr, tc)) {
        const target = board[tr][tc];
        if (!target) {
          addMove(tr, tc, false);
        } else {
          if (target.startsWith(enemyColor)) addMove(tr, tc, true);
          break;
        }
        tr += dr;
        tc += dc;
      }
    }
  }

  return moves;
}

function canCastle(color, side) {
  if (!castlingRights[color === "w" ? "white" : "black"][side]) return false;
  return true;
}

function isValidSquare(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function getLegalMoves(color) {
  const legalMoves = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (piece && piece.startsWith(color[0])) {
        const pseudoMoves = getPseudoLegalMoves(r, c, piece);
        for (const move of pseudoMoves) {
          if (isMoveSafe(move, color)) {
            legalMoves.push(move);
          }
        }
      }
    }
  }
  return legalMoves;
}

function isMoveSafe(move, color) {
  const tempBoard = board.map((row) => [...row]);
  const fromPiece = tempBoard[move.from.r][move.from.c];

  if (move.special === "enpassant") {
    tempBoard[move.from.r][move.to.c] = null;
  }

  tempBoard[move.to.r][move.to.c] = fromPiece;
  tempBoard[move.from.r][move.from.c] = null;

  const kingPos = findKing(tempBoard, color);
  const kRow = fromPiece[1] === "k" ? move.to.r : kingPos.r;
  const kCol = fromPiece[1] === "k" ? move.to.c : kingPos.c;

  if (move.special === "castle-ks") {
    if (isSquareAttacked(move.from.r, move.from.c, color, board)) return false;
    if (isSquareAttacked(move.from.r, move.from.c + 1, color, board))
      return false;
  }
  if (move.special === "castle-qs") {
    if (isSquareAttacked(move.from.r, move.from.c, color, board)) return false;
    if (isSquareAttacked(move.from.r, move.from.c - 1, color, board))
      return false;
  }

  return !isSquareAttacked(kRow, kCol, color, tempBoard);
}

function findKing(boardState, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (boardState[r][c] === color[0] + "k") return { r, c };
    }
  }
  return { r: 0, c: 0 };
}

function isSquareAttacked(r, c, defendingColor, boardState) {
  const enemyPrefix = defendingColor === "white" ? "b" : "w";

  // Pawn attacks
  const attackRow = defendingColor === "white" ? r - 1 : r + 1;
  if (
    isValidSquare(attackRow, c - 1) &&
    boardState[attackRow][c - 1] === enemyPrefix + "p"
  )
    return true;
  if (
    isValidSquare(attackRow, c + 1) &&
    boardState[attackRow][c + 1] === enemyPrefix + "p"
  )
    return true;

  // Knight attacks
  const knightOffsets = [
    [-2, -1],
    [-2, 1],
    [-1, -2],
    [-1, 2],
    [1, -2],
    [1, 2],
    [2, -1],
    [2, 1],
  ];
  for (const [dr, dc] of knightOffsets) {
    if (
      isValidSquare(r + dr, c + dc) &&
      boardState[r + dr][c + dc] === enemyPrefix + "n"
    )
      return true;
  }

  // Sliding
  const dirs = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0], // R/Q
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1], // B/Q
  ];
  for (let i = 0; i < dirs.length; i++) {
    const [dr, dc] = dirs[i];
    let tr = r + dr,
      tc = c + dc;
    while (isValidSquare(tr, tc)) {
      const piece = boardState[tr][tc];
      if (piece) {
        if (piece.startsWith(enemyPrefix)) {
          const type = piece[1];
          if (type === "q") return true;
          if (i < 4 && type === "r") return true;
          if (i >= 4 && type === "b") return true;
        }
        break;
      }
      tr += dr;
      tc += dc;
    }
  }

  // King
  for (let kr = -1; kr <= 1; kr++) {
    for (let kc = -1; kc <= 1; kc++) {
      if (kr === 0 && kc === 0) continue;
      if (
        isValidSquare(r + kr, c + kc) &&
        boardState[r + kr][c + kc] === enemyPrefix + "k"
      )
        return true;
    }
  }

  return false;
}

// --- INTERACTION ---

function handleSquareClick(e) {
  if (isGameOver) return;
  const target = e.target.closest(".square");
  if (!target) return;

  const row = parseInt(target.dataset.row);
  const col = parseInt(target.dataset.col);

  if (selectedSquare) {
    if (selectedSquare.row === row && selectedSquare.col === col) {
      selectedSquare = null;
      clearHighlights();
      return;
    }

    const legalMoves = getLegalMoves(turn);
    const move = legalMoves.find(
      (m) =>
        m.from.r === selectedSquare.row &&
        m.from.c === selectedSquare.col &&
        m.to.r === row &&
        m.to.c === col,
    );

    if (move) {
      makeMove(move);
      selectedSquare = null;
      clearHighlights();
    } else {
      const piece = board[row][col];
      if (piece && piece.startsWith(turn[0])) {
        selectSquare(row, col);
      } else {
        selectedSquare = null;
        clearHighlights();
      }
    }
  } else {
    const piece = board[row][col];
    if (piece && piece.startsWith(turn[0])) {
      selectSquare(row, col);
    }
  }
}

function selectSquare(row, col) {
  selectedSquare = { row, col };
  clearHighlights();
  const sq = document.getElementById(`sq-${row}-${col}`);
  if (sq) sq.classList.add("selected");

  const moves = getLegalMoves(turn);
  const pieceMoves = moves.filter((m) => m.from.r === row && m.from.c === col);

  pieceMoves.forEach((m) => {
    const targetSq = document.getElementById(`sq-${m.to.r}-${m.to.c}`);
    const hint = document.createElement("div");
    hint.classList.add("highlight");
    targetSq.appendChild(hint);
  });
}

function clearHighlights() {
  document.querySelectorAll(".square").forEach((sq) => {
    sq.classList.remove("selected");
    const hl = sq.querySelector(".highlight");
    if (hl) hl.remove();
  });
}

function handleDragStart(e) {
  if (isGameOver) {
    e.preventDefault();
    return;
  }
  const r = parseInt(e.target.dataset.row);
  const c = parseInt(e.target.dataset.col);
  const piece = board[r][c];

  if (!piece || !piece.startsWith(turn[0])) {
    e.preventDefault();
    return;
  }

  selectSquare(r, c);

  grabbedPiece = { r, c };
  e.dataTransfer.effectAllowed = "move";
  setTimeout(() => e.target.classList.add("dragging"), 0);
}

function handleDragOver(e) {
  e.preventDefault();
}

function handleDrop(e) {
  e.preventDefault();
  const target = e.target.closest(".square");
  if (!target || !draggedPiece) return;

  const toRow = parseInt(target.dataset.row);
  const toCol = parseInt(target.dataset.col);

  const legalMoves = getLegalMoves(turn);
  const move = legalMoves.find(
    (m) =>
      m.from.r === grabbedPiece.r &&
      m.from.c === grabbedPiece.c &&
      m.to.r === toRow &&
      m.to.c === toCol,
  );

  if (move) {
    makeMove(move);
    selectedSquare = null;
  }

  grabbedPiece = null;
  clearHighlights(); // Clear highlights
}

function makeMove(move, promotionChoice = null) {
  const fromPiece = board[move.from.r][move.from.c];

  // Check for Promotion (Human)
  if (
    !promotionChoice &&
    fromPiece[1] === "p" &&
    (move.to.r === 0 || move.to.r === 7)
  ) {
    if (gameMode === "solo" && turn === "black") {
      promotionChoice = "q";
    } else {
      pendingPromotion = move;
      showPromotionModal(turn);
      return;
    }
  }

  // Update Castling Rights
  if (fromPiece[1] === "k") {
    castlingRights[turn === "white" ? "white" : "black"].kingSide = false;
    castlingRights[turn === "white" ? "white" : "black"].queenSide = false;
  }
  if (fromPiece[1] === "r") {
    if (move.from.c === 0)
      castlingRights[turn === "white" ? "white" : "black"].queenSide = false;
    if (move.from.c === 7)
      castlingRights[turn === "white" ? "white" : "black"].kingSide = false;
  }

  // Execute Move
  const targetPiece = board[move.to.r][move.to.c];
  if (targetPiece) {
    trackCapture(targetPiece);
  }

  board[move.to.r][move.to.c] = fromPiece;
  board[move.from.r][move.from.c] = null;

  if (move.special === "enpassant") {
    const captureRow = move.from.r;
    const captureCol = move.to.c;
    trackCapture(board[captureRow][captureCol]);
    board[captureRow][captureCol] = null;
  }
  if (move.special === "castle-ks") {
    const row = move.from.r;
    board[row][5] = board[row][7];
    board[row][7] = null;
  }
  if (move.special === "castle-qs") {
    const row = move.from.r;
    board[row][3] = board[row][0];
    board[row][0] = null;
  }

  // Apply Promotion
  if (promotionChoice) {
    board[move.to.r][move.to.c] = turn[0] + promotionChoice;
  }

  // En Passant Target
  if (move.special === "double-push") {
    enPassantTarget = { r: (move.from.r + move.to.r) / 2, c: move.from.c };
  } else {
    enPassantTarget = null;
  }

  updateCapturedUI();
  clearHints();

  // Update move counters
  if (turn === "white") moveCount++;
  halfMoveClock++;
  // Reset half-move clock on pawn move or capture
  if (fromPiece[1] === "p" || targetPiece) halfMoveClock = 0;

  // Switch Turn
  turn = turn === "white" ? "black" : "white";
  statusElement.innerText = `${turn.charAt(0).toUpperCase() + turn.slice(1)}'s Turn`;

  // Animate the piece movement, then re-render
  animateMove(move, () => {
    renderBoard();

    // Highlight last move squares
    const fromSq = document.getElementById(`sq-${move.from.r}-${move.from.c}`);
    const toSq = document.getElementById(`sq-${move.to.r}-${move.to.c}`);
    if (fromSq) fromSq.classList.add("last-move");
    if (toSq) toSq.classList.add("last-move");

    // Check Game Over
    const nextMoves = getLegalMoves(turn);
    if (nextMoves.length === 0) {
      if (
        isSquareAttacked(
          findKing(board, turn).r,
          findKing(board, turn).c,
          turn,
          board,
        )
      ) {
        statusElement.innerText = `Checkmate! ${turn === "white" ? "Black" : "White"} Wins!`;
        showModal(
          "Checkmate!",
          `${turn === "white" ? "Black" : "White"} Wins!`,
        );
      } else {
        statusElement.innerText = "Stalemate! Draw.";
        showModal("Game Over", "Stalemate!");
      }
      isGameOver = true;
    } else {
      if (gameMode === "solo" && turn === "black") {
        setTimeout(makeAIMove, 300);
      }
    }
  }); // End of animateMove callback
}

// Smooth piece movement animation
function animateMove(move, callback) {
  const fromSq = document.getElementById(`sq-${move.from.r}-${move.from.c}`);
  const toSq = document.getElementById(`sq-${move.to.r}-${move.to.c}`);

  if (!fromSq || !toSq) {
    callback();
    return;
  }

  const pieceEl = fromSq.querySelector(".piece");
  if (!pieceEl) {
    callback();
    return;
  }

  // Calculate pixel offset
  const fromRect = fromSq.getBoundingClientRect();
  const toRect = toSq.getBoundingClientRect();
  const dx = toRect.left - fromRect.left;
  const dy = toRect.top - fromRect.top;

  // Apply the smooth transition
  pieceEl.style.transition = "transform 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)";
  pieceEl.style.transform = `translate(${dx}px, ${dy}px)`;
  pieceEl.style.zIndex = "100";

  // Wait for animation to finish, then re-render
  setTimeout(() => {
    pieceEl.style.transition = "";
    pieceEl.style.transform = "";
    pieceEl.style.zIndex = "";
    callback();
  }, 200);
}

// =====================================================
// ELO-BASED AI ENGINE
// =====================================================

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Piece-Square Tables (from black's perspective, mirrored for white)
const PST = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5, 5, 10, 25, 25, 10, 5, 5],
    [0, 0, 0, 20, 20, 0, 0, 0],
    [5, -5, -10, 0, 0, -10, -5, 5],
    [5, 10, 10, -20, -20, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  n: [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20, 0, 0, 0, 0, -20, -40],
    [-30, 0, 10, 15, 15, 10, 0, -30],
    [-30, 5, 15, 20, 20, 15, 5, -30],
    [-30, 0, 15, 20, 20, 15, 0, -30],
    [-30, 5, 10, 15, 15, 10, 5, -30],
    [-40, -20, 0, 5, 5, 0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50],
  ],
  b: [
    [-20, -10, -10, -10, -10, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 10, 10, 10, 10, 0, -10],
    [-10, 5, 5, 10, 10, 5, 5, -10],
    [-10, 0, 5, 10, 10, 5, 0, -10],
    [-10, 10, 10, 10, 10, 10, 10, -10],
    [-10, 5, 0, 0, 0, 0, 5, -10],
    [-20, -10, -10, -10, -10, -10, -10, -20],
  ],
  r: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [5, 10, 10, 10, 10, 10, 10, 5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [0, 0, 0, 5, 5, 0, 0, 0],
  ],
  q: [
    [-20, -10, -10, -5, -5, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 5, 5, 5, 0, -10],
    [-5, 0, 5, 5, 5, 5, 0, -5],
    [0, 0, 5, 5, 5, 5, 0, -5],
    [-10, 5, 5, 5, 5, 5, 0, -10],
    [-10, 0, 5, 0, 0, 0, 0, -10],
    [-20, -10, -10, -5, -5, -10, -10, -20],
  ],
  k: [
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-20, -30, -30, -40, -40, -30, -30, -20],
    [-10, -20, -20, -20, -20, -20, -20, -10],
    [20, 20, 0, 0, 0, 0, 20, 20],
    [20, 30, 10, 0, 0, 10, 30, 20],
  ],
};

// Elo difficulty settings
const ELO_CONFIG = {
  250: { depth: 1, blunderRate: 0.5, name: "Martin" },
  500: { depth: 1, blunderRate: 0.3, name: "Elena" },
  800: { depth: 2, blunderRate: 0.2, name: "Danny" },
  1100: { depth: 2, blunderRate: 0.08, name: "Isabel" },
  1400: { depth: 3, blunderRate: 0.03, name: "Li" },
  1800: { depth: 3, blunderRate: 0.0, name: "Magnus" },
};

let aiElo = 800; // Default

function evaluateBoard(boardState) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = boardState[r][c];
      if (!piece) continue;
      const type = piece[1];
      const val = PIECE_VALUES[type] || 0;
      // PST lookup: for white pieces, mirror the row (7-r); for black, use row as-is
      const pstVal = piece[0] === "b" ? PST[type][r][c] : PST[type][7 - r][c];
      if (piece[0] === "b") {
        score += val + pstVal; // Black is maximizing
      } else {
        score -= val + pstVal; // White pieces subtract (AI plays black)
      }
    }
  }
  return score;
}

function minimax(
  boardState,
  depth,
  alpha,
  beta,
  isMaximizing,
  currentTurn,
  castleR,
  epTarget,
) {
  if (depth === 0) {
    return evaluateBoard(boardState);
  }

  const color = isMaximizing ? "black" : "white";
  const colorPrefix = isMaximizing ? "b" : "w";

  // Gather pseudo-legal moves for this color
  const moves = [];
  const savedBoard = board;
  const savedCR = castlingRights;
  const savedEP = enPassantTarget;
  board = boardState;
  castlingRights = castleR;
  enPassantTarget = epTarget;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = boardState[r][c];
      if (piece && piece[0] === colorPrefix) {
        const pseudoMoves = getPseudoLegalMoves(r, c, piece);
        for (const move of pseudoMoves) {
          if (isMoveSafe(move, color)) {
            moves.push(move);
          }
        }
      }
    }
  }

  board = savedBoard;
  castlingRights = savedCR;
  enPassantTarget = savedEP;

  if (moves.length === 0) {
    // Check if it's checkmate or stalemate
    const kPos = findKing(boardState, color);
    if (isSquareAttacked(kPos.r, kPos.c, color, boardState)) {
      return isMaximizing ? -99999 + (3 - depth) : 99999 - (3 - depth);
    }
    return 0; // Stalemate
  }

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      const newBoard = boardState.map((row) => [...row]);
      const newCR = JSON.parse(JSON.stringify(castleR));
      let newEP = null;

      // Execute move on newBoard
      const fromPiece = newBoard[move.from.r][move.from.c];
      newBoard[move.to.r][move.to.c] = fromPiece;
      newBoard[move.from.r][move.from.c] = null;

      if (move.special === "enpassant") newBoard[move.from.r][move.to.c] = null;
      if (move.special === "castle-ks") {
        newBoard[move.from.r][5] = newBoard[move.from.r][7];
        newBoard[move.from.r][7] = null;
      }
      if (move.special === "castle-qs") {
        newBoard[move.from.r][3] = newBoard[move.from.r][0];
        newBoard[move.from.r][0] = null;
      }
      if (move.special === "double-push")
        newEP = { r: (move.from.r + move.to.r) / 2, c: move.from.c };

      if (fromPiece[1] === "k") {
        newCR[color === "white" ? "white" : "black"].kingSide = false;
        newCR[color === "white" ? "white" : "black"].queenSide = false;
      }
      if (fromPiece[1] === "r") {
        if (move.from.c === 0)
          newCR[color === "white" ? "white" : "black"].queenSide = false;
        if (move.from.c === 7)
          newCR[color === "white" ? "white" : "black"].kingSide = false;
      }

      // Auto-promote to queen for AI
      if (fromPiece[1] === "p" && (move.to.r === 0 || move.to.r === 7)) {
        newBoard[move.to.r][move.to.c] = fromPiece[0] + "q";
      }

      const evalScore = minimax(
        newBoard,
        depth - 1,
        alpha,
        beta,
        false,
        color === "white" ? "black" : "white",
        newCR,
        newEP,
      );
      maxEval = Math.max(maxEval, evalScore);
      alpha = Math.max(alpha, evalScore);
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of moves) {
      const newBoard = boardState.map((row) => [...row]);
      const newCR = JSON.parse(JSON.stringify(castleR));
      let newEP = null;

      const fromPiece = newBoard[move.from.r][move.from.c];
      newBoard[move.to.r][move.to.c] = fromPiece;
      newBoard[move.from.r][move.from.c] = null;

      if (move.special === "enpassant") newBoard[move.from.r][move.to.c] = null;
      if (move.special === "castle-ks") {
        newBoard[move.from.r][5] = newBoard[move.from.r][7];
        newBoard[move.from.r][7] = null;
      }
      if (move.special === "castle-qs") {
        newBoard[move.from.r][3] = newBoard[move.from.r][0];
        newBoard[move.from.r][0] = null;
      }
      if (move.special === "double-push")
        newEP = { r: (move.from.r + move.to.r) / 2, c: move.from.c };

      if (fromPiece[1] === "k") {
        newCR[color === "white" ? "white" : "black"].kingSide = false;
        newCR[color === "white" ? "white" : "black"].queenSide = false;
      }
      if (fromPiece[1] === "r") {
        if (move.from.c === 0)
          newCR[color === "white" ? "white" : "black"].queenSide = false;
        if (move.from.c === 7)
          newCR[color === "white" ? "white" : "black"].kingSide = false;
      }

      if (fromPiece[1] === "p" && (move.to.r === 0 || move.to.r === 7)) {
        newBoard[move.to.r][move.to.c] = fromPiece[0] + "q";
      }

      const evalScore = minimax(
        newBoard,
        depth - 1,
        alpha,
        beta,
        true,
        color === "white" ? "black" : "white",
        newCR,
        newEP,
      );
      minEval = Math.min(minEval, evalScore);
      beta = Math.min(beta, evalScore);
      if (beta <= alpha) break;
    }
    return minEval;
  }
}

function makeAIMove() {
  const config = ELO_CONFIG[aiElo] || ELO_CONFIG[800];

  // Map our Elo to Stockfish Skill Level (0-20) and search depth
  const STOCKFISH_SKILL = {
    250: { skill: 0, depth: 1 },
    500: { skill: 3, depth: 3 },
    800: { skill: 6, depth: 5 },
    1100: { skill: 10, depth: 8 },
    1400: { skill: 15, depth: 12 },
    1800: { skill: 20, depth: 18 },
  };

  if (useStockfish && stockfishReady) {
    // Use Stockfish for AI move
    const fen = boardToFEN();
    const sfConfig = STOCKFISH_SKILL[aiElo] || { skill: 6, depth: 5 };

    askStockfish(fen, sfConfig.depth, sfConfig.skill)
      .then((uciMove) => {
        const coords = uciToCoords(uciMove);
        // Find the matching legal move in our system
        const legalMoves = getLegalMoves("black");
        const move = legalMoves.find(
          (m) =>
            m.from.r === coords.from.r &&
            m.from.c === coords.from.c &&
            m.to.r === coords.to.r &&
            m.to.c === coords.to.c,
        );
        if (move) {
          if (coords.promotion) {
            makeMove(move, coords.promotion);
          } else {
            makeMove(move);
          }
        } else {
          // Fallback if Stockfish move doesn't match (shouldn't happen)
          fallbackAIMove(config);
        }
      })
      .catch(() => {
        fallbackAIMove(config);
      });
  } else {
    fallbackAIMove(config);
  }
}

// Fallback: use built-in minimax AI
function fallbackAIMove(config) {
  const moves = getLegalMoves("black");
  if (moves.length === 0) return;

  let scoredMoves = moves.map((m) => {
    const newBoard = board.map((row) => [...row]);
    const newCR = JSON.parse(JSON.stringify(castlingRights));
    let newEP = null;
    const fromPiece = newBoard[m.from.r][m.from.c];
    newBoard[m.to.r][m.to.c] = fromPiece;
    newBoard[m.from.r][m.from.c] = null;

    if (m.special === "enpassant") newBoard[m.from.r][m.to.c] = null;
    if (m.special === "castle-ks") {
      newBoard[m.from.r][5] = newBoard[m.from.r][7];
      newBoard[m.from.r][7] = null;
    }
    if (m.special === "castle-qs") {
      newBoard[m.from.r][3] = newBoard[m.from.r][0];
      newBoard[m.from.r][0] = null;
    }
    if (m.special === "double-push")
      newEP = { r: (m.from.r + m.to.r) / 2, c: m.from.c };

    if (fromPiece[1] === "p" && (m.to.r === 0 || m.to.r === 7)) {
      newBoard[m.to.r][m.to.c] = fromPiece[0] + "q";
    }

    const score = minimax(
      newBoard,
      config.depth - 1,
      -Infinity,
      Infinity,
      false,
      "white",
      newCR,
      newEP,
    );
    return { move: m, score };
  });

  scoredMoves.sort((a, b) => b.score - a.score);

  let chosenMove;
  if (Math.random() < config.blunderRate && scoredMoves.length > 1) {
    const bottomHalf = scoredMoves.slice(Math.floor(scoredMoves.length / 2));
    chosenMove = bottomHalf[Math.floor(Math.random() * bottomHalf.length)].move;
  } else {
    const bestScore = scoredMoves[0].score;
    const topMoves = scoredMoves.filter((m) => m.score >= bestScore - 10);
    chosenMove = topMoves[Math.floor(Math.random() * topMoves.length)].move;
  }

  makeMove(chosenMove);
}

function trackCapture(piece) {
  if (!piece) return;
  // If black captures white, piece is 'wX', add to list of captured white pieces
  const color = piece[0]; // 'w' or 'b'
  capturedPieces[color].push(piece);
}

function updateCapturedUI() {
  const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  const whiteCapturedEl = document.getElementById("top-captured");
  const blackCapturedEl = document.getElementById("bottom-captured");
  const topScoreEl = document.getElementById("top-score");
  const bottomScoreEl = document.getElementById("bottom-score");

  // Sort captured pieces by value (highest first) for Chess.com style display
  const sortByValue = (a, b) =>
    (PIECE_VALUES[b[1]] || 0) - (PIECE_VALUES[a[1]] || 0);

  // Calculate material points
  let whiteCapturedPoints = 0; // Points of white pieces captured (black's advantage)
  let blackCapturedPoints = 0; // Points of black pieces captured (white's advantage)

  capturedPieces.w.forEach((p) => {
    whiteCapturedPoints += PIECE_VALUES[p[1]] || 0;
  });
  capturedPieces.b.forEach((p) => {
    blackCapturedPoints += PIECE_VALUES[p[1]] || 0;
  });

  const advantage = blackCapturedPoints - whiteCapturedPoints;
  // advantage > 0 means white (bottom) is ahead; < 0 means black (top) is ahead

  // Render captured white pieces (shown at top, next to opponent)
  if (whiteCapturedEl) {
    whiteCapturedEl.innerHTML = "";
    [...capturedPieces.w].sort(sortByValue).forEach((p) => {
      const el = document.createElement("div");
      el.classList.add("piece-mini-unicode");
      el.innerText = PIECES[p[0]][p[1]];
      whiteCapturedEl.appendChild(el);
    });
  }

  // Render captured black pieces (shown at bottom, next to you)
  if (blackCapturedEl) {
    blackCapturedEl.innerHTML = "";
    [...capturedPieces.b].sort(sortByValue).forEach((p) => {
      const el = document.createElement("div");
      el.classList.add("piece-mini-unicode");
      el.innerText = PIECES[p[0]][p[1]];
      blackCapturedEl.appendChild(el);
    });
  }

  // Show material advantage badge
  if (topScoreEl) {
    topScoreEl.innerText = advantage < 0 ? `+${Math.abs(advantage)}` : "";
  }
  if (bottomScoreEl) {
    bottomScoreEl.innerText = advantage > 0 ? `+${advantage}` : "";
  }
}

function showPromotionModal(color) {
  modalTitle.innerText = "Promote Pawn";
  modalMessage.innerText = "Choose a piece:";
  document.getElementById("promotion-options").classList.remove("hidden"); // Fix selector if needed, assuming id matches
  if (promotionOptions) promotionOptions.classList.remove("hidden");

  modalCloseBtn.classList.add("hidden");
  modalOverlay.classList.remove("hidden");
}

function handlePromotionChoice(type) {
  if (pendingPromotion) {
    modalOverlay.classList.add("hidden");
    if (promotionOptions) promotionOptions.classList.add("hidden");
    modalCloseBtn.classList.remove("hidden");

    makeMove(pendingPromotion, type);
    pendingPromotion = null;
  }
}

function showModal(title, msg) {
  modalTitle.innerText = title;
  modalMessage.innerText = msg;
  promotionOptions.classList.add("hidden");
  modalCloseBtn.classList.remove("hidden");
  modalOverlay.classList.remove("hidden");
}

// Controls using event delegation or direct if IDs exist
if (document.getElementById("btn-reset"))
  document.getElementById("btn-reset").addEventListener("click", initGame);
if (document.getElementById("btn-solo"))
  document.getElementById("btn-solo").addEventListener("click", () => {
    const panel = document.getElementById("difficulty-panel");
    if (panel) panel.classList.toggle("hidden");
  });
if (document.getElementById("btn-pvp"))
  document.getElementById("btn-pvp").addEventListener("click", () => {
    gameMode = "pvp";
    const panel = document.getElementById("difficulty-panel");
    if (panel) panel.classList.add("hidden");
    document.getElementById("top-name").innerText = "Player 2";
    initGame();
  });
if (document.getElementById("modal-close"))
  document.getElementById("modal-close").addEventListener("click", () => {
    modalOverlay.classList.add("hidden");
  });

// Difficulty buttons
document.querySelectorAll(".diff-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    aiElo = parseInt(btn.dataset.elo);
    gameMode = "solo";
    const config = ELO_CONFIG[aiElo];
    document.getElementById("top-name").innerText = `${config.name} (${aiElo})`;
    const panel = document.getElementById("difficulty-panel");
    if (panel) panel.classList.add("hidden");
    initGame();
  });
});

document.querySelectorAll(".promo-piece").forEach((p) => {
  p.addEventListener("click", () => handlePromotionChoice(p.dataset.piece));
});

initGame();
