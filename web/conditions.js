// Canopy's conditions (Ken, 2026-10-29): what a scene looks like with its game conditions met.
// Canopy switches objects on and off, and moves and scales them, by expressions over its progress
// flags ("symbols": SkyIsle, TangleDeposits>=4, !Shambles), evaluated by MathEval.cs; this is a
// port of it, exact to its quirks (its own test cases are below), so layout reads an expression as
// the game does. Like MathEval it has compile, which reads an expression once into a program that
// evaluates it without reading the text again (MathProgram in C#; both Claude, 2026-10-29); this is
// where that design was proven, against evaluate, before it went into Canopy. tools/conditions.js finds what the expressions gate when a scene is imported, and
// what each flag is once everything that sets one has (a scene's symbols); the page draws a mode:
//   met    every condition the game can meet, met: as late in the game as the scene goes
//   start  no flags set, as a new game starts
//   saved  as the scene was saved in Unity, conditions ignored
// A gate is a list of terms that must all hold: an expression (a string), { not: term },
// { any: [terms] } or false. Loaded in the page (window.Conditions) and by Node (require).
(function (root) {
    const MUL = 0, DIV = 1, ADD = 2, SUB = 3, CAT = 4, GT = 5, GE = 6, LT = 7, LE = 8, EQ = 9, NEQ = 10, NEG = 11, AND = 12, OR = 13, NOT = 14, START = 19, END = 20;
    const priority = [];
    priority[NOT] = 9; priority[NEG] = 9;
    priority[MUL] = 8; priority[DIV] = 8;
    priority[ADD] = 7; priority[SUB] = 7;
    priority[CAT] = 6;
    priority[GT] = 5; priority[GE] = 5; priority[LT] = 5; priority[LE] = 5;
    priority[EQ] = 4; priority[NEQ] = 4;
    priority[AND] = 3; priority[OR] = 3;
    const prio = op => priority[op] || 0; // C#'s int array: unset entries (START) are 0

    // C#'s Int32.TryParse: optional sign, digits, surrounding spaces; else not a number.
    const INT = /^\s*[+-]?\d+\s*$/;
    const parsesInt = k => typeof k === "string" && INT.test(k) && Math.abs(parseInt(k, 10)) <= 2147483648;
    const getInt = k => (parsesInt(k) ? parseInt(k, 10) | 0 : 0);
    const isInt = k => parsesInt(k === "" ? "0" : k);
    const isIntEither = (a, b) => isInt(a) || isInt(b);
    const isIntBoth = (a, b) => isInt(a) && isInt(b);
    function testBool(k) {
        if (k === null || k === undefined) return false;
        if (isInt(k)) return getInt(k) !== 0;
        return k !== "";
    }
    const str = n => String(n);
    const cat = (a, b) => (a === null || a === undefined ? "" : a) + (b === null || b === undefined ? "" : b); // C# string + null
    const compare = (a, b) => { a = a || ""; b = b || ""; return a < b ? -1 : a > b ? 1 : 0; };
    const isLetter = c => /\p{L}/u.test(c);
    const isLetterOrDigit = c => /[\p{L}\p{Nd}]/u.test(c);
    const isDigit = c => /\p{Nd}/u.test(c);

    // MathEval.Evaluate: the result as text (or null, an unknown symbol's value); lookup(symbol)
    // gives a symbol's value, null when it has none.
    function evaluate(expression, lookup) {
        if (expression === null || expression === undefined || expression === "") return "";
        const ops = [], vals = [];
        let inNumeric = false, inString0 = false, inString1 = false, inSymbol = false, val = "", lastWasOp = true;
        const expr = "(" + expression + ")";
        const top = () => (ops.length ? ops[ops.length - 1] : -1);
        function operate(count) {
            while (count > 0) {
                if (ops.length <= 0) { vals.push("missingNextOp"); return; }
                const op = ops.pop();
                if (op === START || op === END) return;
                if (vals.length <= 0) { vals.push("missingNextVal"); return; }
                let v = vals.pop();
                if (op === NEG) { vals.push(str(-getInt(v) | 0)); --count; continue; }
                if (op === NOT) { vals.push(testBool(v) ? "0" : "1"); --count; continue; }
                if (vals.length <= 0) { vals.push("missingRval"); return; }
                const r = vals.pop();
                if (op === CAT) v = cat(r, v);
                else if (op === ADD) v = isIntBoth(v, r) ? str((getInt(v) + getInt(r)) | 0) : cat(r, v);
                else if (op === SUB) v = str((getInt(r) - getInt(v)) | 0);
                else if (op === MUL) v = str(Math.imul(getInt(r), getInt(v)));
                else if (op === DIV) v = str(getInt(v) === 0 ? 0 : Math.trunc(getInt(r) / getInt(v))); // C# throws; the game would too
                else if (op === GT) v = isIntEither(r, v) ? (getInt(r) > getInt(v) ? "1" : "0") : (compare(r, v) > 0 ? "1" : "0");
                else if (op === GE) v = isIntEither(r, v) ? (getInt(r) >= getInt(v) ? "1" : "0") : (compare(r, v) >= 0 ? "1" : "0");
                else if (op === LT) v = isIntEither(r, v) ? (getInt(r) < getInt(v) ? "1" : "0") : (compare(r, v) < 0 ? "1" : "0");
                else if (op === LE) v = isIntEither(r, v) ? (getInt(r) <= getInt(v) ? "1" : "0") : (compare(r, v) <= 0 ? "1" : "0");
                else if (op === EQ) v = isIntBoth(r, v) ? (getInt(r) === getInt(v) ? "1" : "0") : (r === v ? "1" : "0");
                else if (op === NEQ) v = isIntBoth(r, v) ? (getInt(r) === getInt(v) ? "0" : "1") : (r === v ? "0" : "1");
                else if (op === AND) v = getInt(r) !== 0 && getInt(v) !== 0 ? "1" : "0";
                else if (op === OR) v = getInt(r) !== 0 || getInt(v) !== 0 ? "1" : "0";
                vals.push(v);
                count--;
            }
        }
        // A value just read: a NEG or NOT waiting on top applies to it at once.
        function pushValue(v) {
            if (top() === NEG) { vals.push(str(-getInt(v) | 0)); ops.pop(); }
            else if (top() === NOT) { vals.push(testBool(v) ? "0" : "1"); ops.pop(); }
            else vals.push(v);
        }
        for (let i = 0; i < expr.length; i++) {
            let s = expr[i];
            if (inString0 || inString1) {
                const stop = inString0 ? "\"" : "'";
                const end = i === expr.length - 2;
                if (end && s !== stop) val += s;
                if (s === stop || end) {
                    vals.push(val);
                    inString0 = inString1 = false;
                    val = "";
                    continue;
                }
                if (s === "\\" && expr[i + 1] === stop) s = expr[++i];
                val += s;
                continue;
            }
            if (inSymbol) {
                if (isLetterOrDigit(s) || s === "_" || s === "." || s === ":") { val += s; continue; }
                const result = lookup(val);
                pushValue(result === undefined ? null : result);
                inSymbol = false;
                val = "";
            }
            if (inNumeric) {
                if (isDigit(s)) { val += s; continue; }
                pushValue(val);
                inNumeric = false;
                val = "";
            }
            let op = -1;
            if (s === "(") { ops.push(START); continue; }
            else if (s === "\"") { inString0 = true; val = ""; lastWasOp = false; }
            else if (s === "'") { inString1 = true; val = ""; lastWasOp = false; }
            else if (isDigit(s)) { inNumeric = true; val = s; lastWasOp = false; }
            else if (isLetter(s)) { inSymbol = true; val = s; lastWasOp = false; }
            else if (/\s/.test(s)) { /* nothing */ }
            else if (s === "~") op = CAT;
            else if (s === "+") op = ADD;
            else if (s === "-") op = SUB;
            else if (s === "*") op = MUL;
            else if (s === "/") op = DIV;
            else if (s === "<") { op = LT; if (expr[i + 1] === "=") { op = LE; ++i; } }
            else if (s === ">") { op = GT; if (expr[i + 1] === "=") { op = GE; ++i; } }
            else if (s === "=") { op = EQ; if (expr[i + 1] === "=") ++i; }
            else if (s === "!") { op = NOT; if (expr[i + 1] === "=") { op = NEQ; ++i; } }
            else if (s === "&") { op = AND; if (expr[i + 1] === "&") ++i; }
            else if (s === "|") { op = OR; if (expr[i + 1] === "|") ++i; }
            else if (s === ")") operate(ops.length);
            // anything else is ignored, as MathEval does
            if (op >= 0) {
                if (lastWasOp && op === SUB) { ops.push(NEG); continue; }
                // every waiting operator of equal or higher priority goes first (MathEval let only
                // one, so 1-2*3+4 was -9), except before a ! (it comes before its value, so it can't
                // end anything: !!a was 0); both fixed there too, Claude, 2026-10-29
                if (op !== NOT) while (ops.length && prio(op) <= prio(top())) operate(1);
                ops.push(op);
                lastWasOp = true;
            }
        }
        return vals.length <= 0 ? "" : vals.pop();
    }

    // ---------- compiled programs ----------
    // compile(text) reads an expression once, as evaluate does, but records what evaluate would do
    // instead of doing it: which operations run, and in what order, depends only on the text (the
    // operators waiting, the parentheses, how many values are stacked), never on the values. So a
    // program does exactly what evaluate does, quirks and error values ("missingNextVal") included,
    // and its symbols are what the expression watches. Steps: [CONST, value], [SYMBOL, name],
    // [UNARY, NEG or NOT], [BINARY, op], [DROP]. Values are kept as MathProgram keeps them in C#:
    // { hasText, text, isInt, number }, a number made by arithmetic having no text until one is
    // wanted, and a text's number read once, when it is made.
    const CONST = 0, SYMBOL = 1, UNARY = 2, BINARY = 3, DROP = 4;
    const fromText = t => ({ hasText: true, text: t, isInt: isInt(t), number: getInt(t) });
    const fromInt = i => ({ hasText: false, text: null, isInt: true, number: i });
    const textOf = v => (v.hasText ? v.text : str(v.number));
    const boolOf = v => (v.hasText ? testBool(v.text) : v.number !== 0);
    function compile(expression) {
        const steps = [], symbols = [];
        if (expression === null || expression === undefined || expression === "") return { steps, symbols };
        const ops = [];
        let n = 0; // values stacked when the program runs to here
        let inNumeric = false, inString0 = false, inString1 = false, inSymbol = false, val = "", lastWasOp = true;
        const expr = "(" + expression + ")";
        const top = () => (ops.length ? ops[ops.length - 1] : -1);
        const constant = t => { steps.push([CONST, fromText(t)]); n++; };
        function operate(count) {
            while (count > 0) {
                if (ops.length <= 0) return constant("missingNextOp");
                const op = ops.pop();
                if (op === START || op === END) return;
                if (n <= 0) return constant("missingNextVal");
                if (op === NEG || op === NOT) { steps.push([UNARY, op]); --count; continue; }
                if (n - 1 <= 0) { steps.push([DROP]); n--; return constant("missingRval"); }
                steps.push([BINARY, op]);
                n--;
                count--;
            }
        }
        function pushValue(step) {
            steps.push(step);
            n++;
            if (top() === NEG || top() === NOT) steps.push([UNARY, ops.pop()]);
        }
        for (let i = 0; i < expr.length; i++) {
            let s = expr[i];
            if (inString0 || inString1) {
                const stop = inString0 ? "\"" : "'";
                const end = i === expr.length - 2;
                if (end && s !== stop) val += s;
                if (s === stop || end) {
                    constant(val);
                    inString0 = inString1 = false;
                    val = "";
                    continue;
                }
                if (s === "\\" && expr[i + 1] === stop) s = expr[++i];
                val += s;
                continue;
            }
            if (inSymbol) {
                if (isLetterOrDigit(s) || s === "_" || s === "." || s === ":") { val += s; continue; }
                symbols.push(val);
                pushValue([SYMBOL, val]);
                inSymbol = false;
                val = "";
            }
            if (inNumeric) {
                if (isDigit(s)) { val += s; continue; }
                pushValue([CONST, fromText(val)]);
                inNumeric = false;
                val = "";
            }
            let op = -1;
            if (s === "(") { ops.push(START); continue; }
            else if (s === "\"") { inString0 = true; val = ""; lastWasOp = false; }
            else if (s === "'") { inString1 = true; val = ""; lastWasOp = false; }
            else if (isDigit(s)) { inNumeric = true; val = s; lastWasOp = false; }
            else if (isLetter(s)) { inSymbol = true; val = s; lastWasOp = false; }
            else if (/\s/.test(s)) { /* nothing */ }
            else if (s === "~") op = CAT;
            else if (s === "+") op = ADD;
            else if (s === "-") op = SUB;
            else if (s === "*") op = MUL;
            else if (s === "/") op = DIV;
            else if (s === "<") { op = LT; if (expr[i + 1] === "=") { op = LE; ++i; } }
            else if (s === ">") { op = GT; if (expr[i + 1] === "=") { op = GE; ++i; } }
            else if (s === "=") { op = EQ; if (expr[i + 1] === "=") ++i; }
            else if (s === "!") { op = NOT; if (expr[i + 1] === "=") { op = NEQ; ++i; } }
            else if (s === "&") { op = AND; if (expr[i + 1] === "&") ++i; }
            else if (s === "|") { op = OR; if (expr[i + 1] === "|") ++i; }
            else if (s === ")") operate(ops.length);
            if (op >= 0) {
                if (lastWasOp && op === SUB) { ops.push(NEG); continue; }
                if (op !== NOT) while (ops.length && prio(op) <= prio(top())) operate(1);
                ops.push(op);
                lastWasOp = true;
            }
        }
        return { steps, symbols };
    }
    function binary(op, r, v) {
        const intEither = r.isInt || v.isInt, intBoth = r.isInt && v.isInt;
        const cmp = () => compare(r.text, v.text); // only when neither is a number: both have text
        // equal, when not both numbers: never if either is a number made by arithmetic (the other
        // isn't a number, and its text would be), else their texts
        const same = () => (!r.hasText || !v.hasText ? false : r.text === v.text);
        switch (op) {
            case CAT: return fromText(cat(textOf(r), textOf(v)));
            case ADD: return intBoth ? fromInt((v.number + r.number) | 0) : fromText(cat(textOf(r), textOf(v)));
            case SUB: return fromInt((r.number - v.number) | 0);
            case MUL: return fromInt(Math.imul(r.number, v.number));
            case DIV: return fromInt(v.number === 0 ? 0 : Math.trunc(r.number / v.number)); // C# throws
            case GT: return fromInt((intEither ? r.number > v.number : cmp() > 0) ? 1 : 0);
            case GE: return fromInt((intEither ? r.number >= v.number : cmp() >= 0) ? 1 : 0);
            case LT: return fromInt((intEither ? r.number < v.number : cmp() < 0) ? 1 : 0);
            case LE: return fromInt((intEither ? r.number <= v.number : cmp() <= 0) ? 1 : 0);
            case EQ: return fromInt((intBoth ? r.number === v.number : same()) ? 1 : 0);
            case NEQ: return fromInt((intBoth ? r.number === v.number : same()) ? 0 : 1);
            case AND: return fromInt(r.number !== 0 && v.number !== 0 ? 1 : 0);
            case OR: return fromInt(r.number !== 0 || v.number !== 0 ? 1 : 0);
        }
        return v;
    }
    // A program's result: its value (as text, as evaluate gives it, with asBool its truth), or none.
    function run(program, lookup, asBool = false) {
        const stack = [];
        for (const [kind, arg] of program.steps) {
            if (kind === CONST) stack.push(arg);
            else if (kind === SYMBOL) { const t = lookup(arg); stack.push(fromText(t === undefined ? null : t)); }
            else if (kind === UNARY) { const v = stack.pop(); stack.push(fromInt(arg === NEG ? -v.number | 0 : boolOf(v) ? 0 : 1)); }
            else if (kind === BINARY) { const v = stack.pop(), r = stack.pop(); stack.push(binary(arg, r, v)); }
            else stack.pop();
        }
        if (asBool) return stack.length ? boolOf(stack[stack.length - 1]) : false;
        return stack.length ? textOf(stack[stack.length - 1]) : "";
    }
    // Each text's program, made once.
    const programs = new Map();
    const programFor = text => {
        const key = text ?? "";
        if (!programs.has(key)) programs.set(key, compile(key));
        return programs.get(key);
    };

    // A symbol table's lookup: Expression.cs's tokens ("this" is resolved when imported, "limb" is
    // no limb), then the flags (ProgressFlags: null when never set).
    const lookupIn = symbols => token => (token === "limb" ? "None" : Object.prototype.hasOwnProperty.call(symbols, token) ? symbols[token] : null);
    function holds(term, symbols) {
        if (term === false || term === null || term === undefined) return false;
        if (term === true) return true;
        if (typeof term === "string") return run(programFor(term), lookupIn(symbols), true);
        if (term.not !== undefined) return !holds(term.not, symbols);
        if (term.any) return term.any.some(t => holds(t, symbols));
        return false;
    }
    const allHold = (terms, symbols) => (terms || []).every(t => holds(t, symbols));
    // A gate's terms as text, for probes and status lines.
    function describe(term) {
        if (term === false) return "never";
        if (typeof term === "string") return term;
        if (term.not !== undefined) return `not (${describe(term.not)})`;
        if (term.any) return term.any.map(describe).join(" or ");
        return String(term);
    }

    // MathEval.Test's cases, with its interpreter; returns the failures.
    function test() {
        const table = { a: "1", b: "5", c: "hello", d: "world", e: "0" };
        const interp = s => (s in table ? table[s] : "");
        const cases = [
            ["e==0 && notDefined", "0"], ["", ""], ["!0", "1"], ["!32", "0"], ["!a && b", "0"], ["b+!a", "5"], ["1!=5", "1"],
            ["77!=70+7", "0"], ["b!=a", "1"], ["a==1 && !e", "1"], ["0", "0"], ["1", "1"], ["1+1", "2"], ["1>0", "1"], ["1<0", "0"],
            ["1>=0", "1"], ["1<=0", "0"], ["10==10", "1"], ["1==0", "0"], ["305-7", "298"], ["4+5*-2", "-6"], ["-40", "-40"],
            ["-40*3+11", "-109"], ["-7*-4", "28"], ["2*2+4*4", "20"], ["8+9*8-1020*4", "-4000"], ["2*2+4<8+9*8-1000*4", "0"],
            ["10/2", "5"], ["(2*6)-(20/5)", "8"], ["a+1", "2"], ["2+a", "3"], ["a>b", "0"], ["a<b", "1"], ["a+b", "6"], ["-11==-b-6", "1"],
            ["((4*a)+(8*b))", "44"], ["((4*a)+(8*b)) < 5", "0"], ["66+(5-(3*2))+1*4", "69"], ["8*(2+4)*100", "4800"],
            ["10-9-8-7-6-5-4-3-2-1", "-35"], ["-b--7--a", "3"], ["-b", "-5"], ["(b+6==11)+10", "11"], ["10+(b+6==11)", "11"],
            ["'   '", "   "], ["'a  '", "a  "], ["'  b'", "  b"], ["'hello world'", "hello world"], ["\"hello world\"", "hello world"],
            ["'hello '~'world'", "hello world"], ["('hello' ~ ' ') ~ 'world'", "hello world"], ["c~' '~d", "hello world"], ["''~1~2~3", "123"],
            ["'a'~3", "a3"], ["''~(5+a+1)~'k'", "7k"], ["''~111~\"a\"~222", "111a222"], ["'12'~4", "124"], ["c~b", "hello5"], ["'hello", "hello"],
            ["a>0 && b>0", "1"], ["e==0 && a", "1"], ["'frog'=='frog'", "1"], ["'frog'+1", "frog1"], ["c+' '+d", "hello world"],
            ["1-'frog'", "1"], ["!''", "1"], ["!'frog'", "0"], ["'frog'=='dovetail'", "0"]
        ];
        const failures = cases.map(([e, want]) => [e, want, evaluate(e, interp)]).filter(([, want, got]) => got !== want).map(([e, want, got]) => `[${e}] = [${got}], should be [${want}]`);
        const bools = [["0", false], ["1", true], ["-1", true], ["", false], ["hello", true]];
        for (const [k, want] of bools) if (testBool(k) !== want) failures.push(`TestBool(${k}) is ${!want}`);
        // the game's own: an unset flag is null, so even "X==0" fails until something sets X
        const flags = lookupIn({ SkyIsle: "1", TangleDeposits: "6", StageName: "Tangle" });
        const game = [["SkyIsle", true], ["!SkyIsle", false], ["Shambles", false], ["!Shambles", true], ["TangleDeposits>=4", true],
            ["StageName=\"Tangle\"", true], ["StageName=\"Oak\"", false], ["Skill.WalkBadge==0", false], ["limb=='Left' && !MayRemoveGems", false]];
        for (const [e, want] of game) if (testBool(evaluate(e, flags)) !== want) failures.push(`game: [${e}] should be ${want}`);
        for (const [e, want] of [["1-2*3+4", "-1"], ["0 && 1==1 || 1", "1"], ["!!b", "1"], ["-!e", "-1"]]) if (evaluate(e, interp) !== want) failures.push(`[${e}] = [${evaluate(e, interp)}], should be [${want}]`);
        // every case again, compiled: the same result
        for (const [e] of [...cases, ["1-2*3+4"], ["0 && 1==1 || 1"], ["!!b"], ["-!e"]]) if (run(compile(e), interp) !== evaluate(e, interp)) failures.push(`compiled [${e}] = [${run(compile(e), interp)}], evaluated [${evaluate(e, interp)}]`);
        return failures;
    }

    const Conditions = { evaluate, compile, run, programFor, testBool, holds, allHold, describe, test, MODES: ["met", "start", "saved"] };
    if (typeof module === "object" && module.exports) module.exports = Conditions;
    else root.Conditions = Conditions;
})(typeof window === "object" ? window : this);
