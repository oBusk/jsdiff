import type {ChangeObject, AllDiffOptions, AbortableDiffOptions, DiffCallbackNonabortable, CallbackOptionAbortable, CallbackOptionNonabortable, DiffCallbackAbortable, TimeoutOption, MaxEditLengthOption} from '../types.js';
import {enqueueTask} from '../util/yield.js';

/**
 * Like a ChangeObject, but with no value and an extra `previousComponent` property.
 * A linked list of these (linked via `.previousComponent`) is used internally in the code below to
 * keep track of the state of the diffing algorithm, but gets converted to an array of
 * ChangeObjects before being returned to the caller.
 */
interface DraftChangeObject {
    added: boolean;
    removed: boolean;
    count: number;
    previousComponent?: DraftChangeObject;

    // Only added in buildValues:
    value?: any;
}

interface Path {
  oldPos: number;
  lastComponent: DraftChangeObject | undefined
}

/**
 * What discardUnmatched() leaves for the search to work on: the tokens from `start` onwards that
 * have a match on the other side, plus where they came from so that the discarded ones can be put
 * back afterwards (see expandDiscarded()).
 */
interface Discarded {
  // Tokens before this index form the common prefix of both texts and are left out below.
  start: number;
  // The kept tokens, each replaced by a number shared by all tokens equal to it (see
  // numberTokens()), and their indices in the full token arrays.
  oldIds: Int32Array;
  newIds: Int32Array;
  oldIndices: Int32Array;
  newIndices: Int32Array;
  // The number of tokens discarded, from both texts together.
  count: number;
}

/**
 * The edit length at which the search stops to discard unmatched tokens, given how many tokens
 * follow the common prefix.
 *
 * Discarding means hashing all of those tokens and then starting the search again, which costs
 * more than the whole of a search that only needs a short edit script (say, one changed line in a
 * long file). So we only do it once the search has run for a while without finishing. By edit
 * length d it has visited up to about d²/2 diagonals; at d = 2√n, that's about 2n of them for n
 * tokens, which benchmarks put at about what discarding costs. Whether the diff turns out short or
 * long, this keeps it from taking more than about twice as long as it would with the better choice.
 */
function discardEditLength(tokenCount: number): number {
  return Math.max(16, Math.ceil(2 * Math.sqrt(tokenCount)));
}

// MurmurHash3 (32-bit) over the string's UTF-16 code units, taking two of them per 32-bit block.
function hashString(s: string): number {
  const len = s.length;
  let h = 0, i = 0;
  for (; i + 1 < len; i += 2) {
    let k = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  if (i < len) {
    let k = Math.imul(s.charCodeAt(i), 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
  }
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

/**
 * Numbers the distinct tokens in oldTokens and newTokens from index `start` onwards, so that two
 * tokens get the same number exactly when they are ===. Returns the numbers of the old tokens, of
 * the new tokens, and how many numbers were handed out.
 */
function numberTokens<TokenT>(
  oldTokens: TokenT[],
  newTokens: TokenT[],
  start: number
): [Int32Array, Int32Array, number] {
  // String tokens go in a hash table of our own rather than a Map, because V8 internalizes strings
  // used as Map keys: for a token that is a slice of the input, that allocates a full copy that
  // stays alive, through the token, for the rest of the diff. Here we hash the characters
  // ourselves and only compare strings with ===, which copies nothing. The table is at most half
  // full, so probe sequences stay short.
  let capacity = 16;
  while (capacity < (oldTokens.length + newTokens.length - 2 * start) * 2) {
    capacity *= 2;
  }
  const mask = capacity - 1,
        slotIds = new Int32Array(capacity), // number + 1, so that 0 marks an empty slot
        slotHashes = new Int32Array(capacity),
        slotTokens: string[] = new Array(capacity);
  // Other tokens (only possible in diffArrays) are compared by identity, which a Map does without
  // copying anything.
  const otherIds = new Map<TokenT, number>();
  let nextId = 0;
  function toIds(tokens: TokenT[]) {
    const ids = new Int32Array(tokens.length - start);
    for (let i = start; i < tokens.length; i++) {
      const token = tokens[i];
      let id;
      if (typeof token === 'string') {
        const hash = hashString(token);
        let slot = hash & mask;
        for (;;) {
          const slotId = slotIds[slot];
          if (slotId === 0) {
            id = nextId++;
            slotIds[slot] = id + 1;
            slotHashes[slot] = hash;
            slotTokens[slot] = token;
            break;
          }
          if (slotHashes[slot] === hash && slotTokens[slot] === token) {
            id = slotId - 1;
            break;
          }
          slot = (slot + 1) & mask;
        }
      } else {
        id = otherIds.get(token);
        if (id === undefined) {
          id = nextId++;
          // A Map treats NaN as equal to itself, but === doesn't, so each NaN gets its own number.
          if (!Number.isNaN(token)) {
            otherIds.set(token, id);
          }
        }
      }
      ids[i - start] = id;
    }
    return ids;
  }
  const oldIds = toIds(oldTokens), newIds = toIds(newTokens);
  return [oldIds, newIds, nextId];
}

// The numbers that occur on the other side, and the indices (counting from `start`) of the tokens
// they belong to.
function keep(ids: Int32Array, otherCounts: Int32Array, start: number): [Int32Array, Int32Array] {
  let kept = 0;
  for (let i = 0; i < ids.length; i++) {
    if (otherCounts[ids[i]]) {
      kept++;
    }
  }
  const keptIds = new Int32Array(kept),
        indices = new Int32Array(kept);
  for (let i = 0, j = 0; i < ids.length; i++) {
    if (otherCounts[ids[i]]) {
      keptIds[j] = ids[i];
      indices[j++] = start + i;
    }
  }
  return [keptIds, indices];
}

/**
 * Finds the tokens from index `start` onwards that have no match at all on the other side. No path
 * through the edit graph can match such a token, so it's removed (or added) whatever the diff, and
 * the search can leave it out; on inputs that differ a lot, that makes the search much smaller.
 * (GNU diff and xdiff do the same.) Returns undefined if every token has a match.
 */
function discardUnmatched<TokenT>(
  oldTokens: TokenT[],
  newTokens: TokenT[],
  start: number
): Discarded | undefined {
  const [oldIds, newIds, idCount] = numberTokens(oldTokens, newTokens, start);
  const oldCounts = new Int32Array(idCount),
        newCounts = new Int32Array(idCount);
  for (let i = 0; i < oldIds.length; i++) {
    oldCounts[oldIds[i]]++;
  }
  for (let i = 0; i < newIds.length; i++) {
    newCounts[newIds[i]]++;
  }
  const [oldKeptIds, oldIndices] = keep(oldIds, newCounts, start),
        [newKeptIds, newIndices] = keep(newIds, oldCounts, start);
  const count = oldIds.length - oldIndices.length + newIds.length - newIndices.length;
  if (!count) {
    return undefined;
  }
  return {start, oldIds: oldKeptIds, newIds: newKeptIds, oldIndices, newIndices, count};
}

/**
 * Turns the components found by a search over the tokens kept by discardUnmatched() back into
 * components over the full texts, by putting back the common prefix and the discarded tokens.
 *
 * A discarded old token goes in as a removal as early as it can: right after the old token before
 * it, ahead of any addition that could come first. A discarded new token goes in as an addition as
 * late as it can: right before the next component that needs the new token after it. That is where
 * a search over the full texts would have put them, since it extends removals before additions
 * whenever it can choose; for instance, it diffs `FF` to `FG` as `=F -F +G`, not `=F +G -F`. This
 * was checked against searches over the full texts on millions of random inputs, and the result
 * is the same, component for component.
 */
function expandDiscarded(
  components: DraftChangeObject[],
  discarded: Discarded,
  oldLen: number,
  newLen: number,
  oneChangePerToken: boolean
): DraftChangeObject[] {
  const result: DraftChangeObject[] = [];
  // Appends `count` tokens of one kind, merging them into the last component like addToPath does.
  function push(added: boolean, removed: boolean, count: number) {
    if (oneChangePerToken) {
      for (let i = 0; i < count; i++) {
        result.push({count: 1, added, removed});
      }
    } else if (count) {
      const last = result[result.length - 1];
      if (last && last.added === added && last.removed === removed) {
        last.count += count;
      } else {
        result.push({count, added, removed});
      }
    }
  }
  const {oldIndices, newIndices} = discarded;
  // Positions in the full token arrays up to which tokens have been emitted, and in the kept ones.
  let oldPos = discarded.start, newPos = discarded.start, oldKept = 0, newKept = 0;
  function removeUpTo(end: number) {
    push(false, true, end - oldPos);
    oldPos = end;
  }
  function addUpTo(end: number) {
    push(true, false, end - newPos);
    newPos = end;
  }

  push(false, false, discarded.start);
  for (const component of components) {
    for (let i = 0; i < component.count; i++) {
      if (component.added) {
        removeUpTo(oldKept < oldIndices.length ? oldIndices[oldKept] : oldLen);
        addUpTo(newIndices[newKept++]);
        push(true, false, 1);
        newPos++;
      } else if (component.removed) {
        removeUpTo(oldIndices[oldKept++]);
        push(false, true, 1);
        oldPos++;
      } else {
        removeUpTo(oldIndices[oldKept++]);
        addUpTo(newIndices[newKept++]);
        push(false, false, 1);
        oldPos++;
        newPos++;
      }
    }
  }
  removeUpTo(oldLen);
  addUpTo(newLen);
  return result;
}

export default class Diff<
  TokenT,
  ValueT extends Iterable<TokenT> = Iterable<TokenT>,
  InputValueT = ValueT
> {
  diff(
    oldStr: InputValueT,
    newStr: InputValueT,
    options: DiffCallbackNonabortable<ValueT>
  ): undefined;
  diff(
    oldStr: InputValueT,
    newStr: InputValueT,
    options: AllDiffOptions & AbortableDiffOptions & CallbackOptionAbortable<ValueT>
  ): undefined
  diff(
    oldStr: InputValueT,
    newStr: InputValueT,
    options: AllDiffOptions & CallbackOptionNonabortable<ValueT>
  ): undefined
  diff(
    oldStr: InputValueT,
    newStr: InputValueT,
    options: AllDiffOptions & AbortableDiffOptions
  ): ChangeObject<ValueT>[] | undefined
  diff(
    oldStr: InputValueT,
    newStr: InputValueT,
    options?: AllDiffOptions
  ): ChangeObject<ValueT>[]
  diff(
    oldStr: InputValueT,
    newStr: InputValueT,
    // Type below is not accurate/complete - see above for full possibilities - but it compiles
    options: DiffCallbackNonabortable<ValueT> | AllDiffOptions & Partial<CallbackOptionNonabortable<ValueT>> = {}
  ): ChangeObject<ValueT>[] | undefined {
    let callback: DiffCallbackAbortable<ValueT> | DiffCallbackNonabortable<ValueT> | undefined;
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if ('callback' in options) {
      callback = options.callback;
    }
    // Allow subclasses to massage the input prior to running
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);

    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));

    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }

  private diffWithOptionsObj(
    oldTokens: TokenT[],
    newTokens: TokenT[],
    options: AllDiffOptions & Partial<TimeoutOption> & Partial<MaxEditLengthOption>,
    callback: DiffCallbackAbortable<ValueT> | DiffCallbackNonabortable<ValueT> | undefined
  ): ChangeObject<ValueT>[] | undefined {
    const done = (value: ChangeObject<ValueT>[]) => {
      value = this.postProcess(value, options);
      if (callback) {
        enqueueTask(function() { callback(value); });
        return undefined;
      } else {
        return value;
      }
    };

    let maxEditLength = newTokens.length + oldTokens.length;
    if(options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = options.timeout ?? Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;

    // Tokens are compared in normalized form, but the returned change objects are built from the
    // original tokens. The search runs on these arrays, which discardUnmatchedTokens() below may
    // replace with shorter ones.
    let oldNormalized = oldTokens.map(token => this.normalizeToken(token, options)),
        newNormalized = newTokens.map(token => this.normalizeToken(token, options));

    // Set once discardUnmatchedTokens() has replaced the arrays above, so that finish() can put
    // the discarded tokens back.
    let discarded: Discarded | undefined;
    const finish = (lastComponent: DraftChangeObject | undefined) => {
      return done(this.buildValues(lastComponent, newTokens, oldTokens, discarded, options));
    };

    // The state of the search, set up by init().
    let oldLen = 0, newLen = 0, editLength = 0, newPos = 0, offset = 0, prefixLen = 0;
    let bestPath: Path[] = [];
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;

    // Sets up the search for a path through the edit graph of oldNormalized and newNormalized,
    // and, like execEditLength() below, returns a truthy value if it has already found the path.
    const init = () => {
      oldLen = oldNormalized.length;
      newLen = newNormalized.length;
      editLength = 1;

      // Seed editLength = 0, i.e. the content starts with the same values
      const initialPath: Path = { oldPos: -1, lastComponent: undefined };
      newPos = this.extractCommon(initialPath, newNormalized, oldNormalized, 0, options);
      if (initialPath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
        // Identity per the equality and tokenizer
        return finish(initialPath.lastComponent) || true;
      }
      prefixLen = newPos + 1;

      // bestPath[offset + k] holds the furthest-reaching path on diagonal k = oldPos - newPos.
      // Positions range over -1 <= oldPos < oldLen and -1 <= newPos < newLen, so the edit graph has
      // the oldLen + newLen + 1 diagonals -newLen..oldLen, and the loop below never leaves them: a
      // path that reaches an edge of the graph stops the exploration beyond it (see
      // minDiagonalToConsider and maxDiagonalToConsider). The loop also reads k - 1 and k + 1, hence
      // one spare slot on each side. Diagonals go negative, and JavaScript engines store negative
      // array indices as ordinary named properties rather than as array elements, which would make
      // every lookup in the loop a slow dictionary access; the offset keeps every index within
      // [0, oldLen + newLen + 2].
      offset = newLen + 1;
      bestPath = new Array(oldLen + newLen + 3);
      bestPath[offset] = initialPath;

      // Once we hit the right edge of the edit graph on some diagonal k, we can
      // definitely reach the end of the edit graph in no more than k edits, so
      // there's no point in considering any moves to diagonal k+1 any more (from
      // which we're guaranteed to need at least k+1 more edits).
      // Similarly, once we've reached the bottom of the edit graph, there's no
      // point considering moves to lower diagonals.
      // We record this fact by setting minDiagonalToConsider and
      // maxDiagonalToConsider to some finite value once we've hit the edge of
      // the edit graph.
      // This optimization is not faithful to the original algorithm presented in
      // Myers's paper, which instead pointlessly extends D-paths off the end of
      // the edit graph - see page 7 of Myers's paper which notes this point
      // explicitly and illustrates it with a diagram. This has major performance
      // implications for some common scenarios. For instance, to compute a diff
      // where the new text simply appends d characters on the end of the
      // original text of length n, the true Myers algorithm will take O(n+d^2)
      // time while this optimization needs only O(n+d) time.
      minDiagonalToConsider = -Infinity;
      maxDiagonalToConsider = Infinity;

      // The seed path may already sit on an edge of the graph (one text empty, or a prefix of the
      // other). Apply the same rule as the loop below; otherwise the first iteration would read one
      // slot before the start of bestPath when the new text is empty.
      if (initialPath.oldPos + 1 >= oldLen) {
        maxDiagonalToConsider = -1;
      }
      if (newPos + 1 >= newLen) {
        minDiagonalToConsider = 1;
      }
      return undefined;
    };

    const identical = init();
    if (identical) {
      return identical === true ? undefined : identical;
    }

    // The edit length at which the drivers below call discardUnmatchedTokens() instead of
    // execEditLength(), or -1 for never. Tokens can only be discarded when they are compared with
    // plain ===, since we need to hash them; a comparator or an overridden equals() could
    // implement any notion of equality.
    let discardAt = -1;
    if (!options.comparator && this.equals === Diff.prototype.equals) {
      discardAt = discardEditLength(oldLen + newLen - 2 * prefixLen);
    }

    // Restarts the search without the tokens after the common prefix that have no match on the
    // other side. The result is the same; see discardUnmatched() and expandDiscarded().
    function discardUnmatchedTokens() {
      discardAt = -1;
      const result = discardUnmatched(oldNormalized, newNormalized, prefixLen);
      if (!result) {
        // Nothing to discard, so carry on with the search we have.
        return undefined;
      }
      // Each discarded token is an edit, so the edit script for the remaining tokens can only be
      // that much shorter. If that leaves nothing, the drivers abort as they would have later on.
      maxEditLength -= result.count;
      if (maxEditLength < 0) {
        return undefined;
      }
      discarded = result;
      // The numbers compare with === just like the tokens they stand for, and comparing them is
      // cheaper than comparing strings, so the new search runs on them.
      oldNormalized = result.oldIds as unknown as TokenT[];
      newNormalized = result.newIds as unknown as TokenT[];
      return init();
    }

    // Main worker method. checks all permutations of a given edit length for acceptance.
    const execEditLength = () => {
      // k here represents the number of a diagonal in the edit graph
      // (The variable name k is chosen to match the Myers diff paper)
      for (
        let k = Math.max(minDiagonalToConsider, -editLength);
        k <= Math.min(maxDiagonalToConsider, editLength);
        k += 2
      ) {
        let basePath;
        const removePath = bestPath[offset + k - 1],
              addPath = bestPath[offset + k + 1];
        if (removePath) {
          // No one else is going to attempt to use this value, clear it
          // @ts-expect-error - perf optimisation. This type-violating value will never be read.
          bestPath[offset + k - 1] = undefined;
        }

        const canAdd = addPath && addPath.oldPos - k < newLen;
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          // If this path is a terminal then prune
          // @ts-expect-error - perf optimisation. This type-violating value will never be read.
          bestPath[offset + k] = undefined;
          continue;
        }

        // Select the diagonal that we want to branch from. We select the prior
        // path whose position in the old string is the farthest from the origin
        // and does not pass the bounds of the diff graph
        if (!canRemove || (canAdd && removePath.oldPos < addPath.oldPos)) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }

        newPos = this.extractCommon(basePath, newNormalized, oldNormalized, k, options);

        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          // If we have hit the end of both strings, then we are done
          return finish(basePath.lastComponent) || true;
        } else {
          bestPath[offset + k] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, k - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, k + 1);
          }
        }
      }

      editLength++;
    };

    // Performs the length of edit iteration. Is a bit fugly as this has to support the
    // sync and async mode which is never fun. Loops over execEditLength until a value
    // is produced, or until the edit length exceeds options.maxEditLength (if given),
    // in which case it will return undefined.
    if (callback) {
      (function exec() {
        enqueueTask(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return (callback as DiffCallbackAbortable<ValueT>)(undefined);
          }

          if (!(editLength === discardAt ? discardUnmatchedTokens() : execEditLength())) {
            exec();
          }
        });
      }());
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = editLength === discardAt ? discardUnmatchedTokens() : execEditLength();
        if (ret) {
          return ret as ChangeObject<ValueT>[];
        }
      }
    }
  }

  private addToPath(
    path: Path,
    added: boolean,
    removed: boolean,
    oldPosInc: number,
    options: AllDiffOptions
  ): Path {
    const last = path.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: {count: last.count + 1, added: added, removed: removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: {count: 1, added: added, removed: removed, previousComponent: last }
      };
    }
  }

  private extractCommon(
    basePath: Path,
    newTokens: TokenT[],
    oldTokens: TokenT[],
    k: number,
    options: AllDiffOptions
  ): number {
    const newLen = newTokens.length,
          oldLen = oldTokens.length;
    let oldPos = basePath.oldPos,
        newPos = oldPos - k,
        commonCount = 0;

    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = {count: 1, previousComponent: basePath.lastComponent, added: false, removed: false};
      }
    }

    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = {count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false};
    }

    basePath.oldPos = oldPos;
    return newPos;
  }

  // Receives tokens that have already been through normalizeToken().
  equals(left: TokenT, right: TokenT, options: AllDiffOptions): boolean {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right;
    }
  }

  // Maps a token to the form it should be compared in (e.g. lowercased). Called once per token up
  // front, rather than on every call to equals(), which the diff loop makes many times per token.
  // Subclasses that override this should build on super.normalizeToken() so that ignoreCase keeps
  // working.
  normalizeToken(token: TokenT, options: AllDiffOptions): TokenT {
    // Only strings have a case. Tokens can be any value in diffArrays, which has no ignoreCase
    // option but may still be passed one, so leave other tokens alone rather than throwing.
    if (options.ignoreCase && typeof token === 'string') {
      // toLowerCase() may return a copy even when nothing changed (e.g. in V8 for longer or
      // non-ASCII strings), and the normalized tokens are kept for the whole diff. Returning the
      // original token where we can means only tokens that contained uppercase letters cost
      // extra memory.
      const lower = token.toLowerCase();
      if(lower !== token) {
        return lower as TokenT;
      }
    }
    return token;
  }

  removeEmpty(array: TokenT[]): TokenT[] {
    const ret: TokenT[] = [];
    for (let i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  castInput(value: InputValueT, options: AllDiffOptions): ValueT {
    return value as unknown as ValueT;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(value: ValueT, options: AllDiffOptions): TokenT[] {
    return Array.from(value);
  }

  join(chars: TokenT[]): ValueT {
    // Assumes ValueT is string, which is the case for most subclasses.
    // When it's false, e.g. in diffArrays, this method needs to be overridden (e.g. with a no-op)
    // Yes, the casts are verbose and ugly, because this pattern - of having the base class SORT OF
    // assume tokens and values are strings, but not completely - is weird and janky.
    return (chars as string[]).join('') as unknown as ValueT;
  }

  postProcess(
    changeObjects: ChangeObject<ValueT>[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options: AllDiffOptions
  ): ChangeObject<ValueT>[] {
    return changeObjects;
  }

  get useLongestToken(): boolean {
    return false;
  }

  private buildValues(
    lastComponent: DraftChangeObject | undefined,
    newTokens: TokenT[],
    oldTokens: TokenT[],
    discarded: Discarded | undefined,
    options: AllDiffOptions
  ): ChangeObject<ValueT>[] {
    // First we convert our linked list of components in reverse order to an
    // array in the right order:
    let components: DraftChangeObject[] = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();

    // If the search left out unmatched tokens, put them back.
    if (discarded) {
      components = expandDiscarded(
        components, discarded, oldTokens.length, newTokens.length, !!options.oneChangePerToken
      );
    }

    const componentLen = components.length;
    let componentPos = 0,
        newPos = 0,
        oldPos = 0;

    for (; componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value, i) {
            const oldValue = oldTokens[oldPos + i];
            return (oldValue as string).length > (value as string).length ? oldValue : value;
          });

          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;

        // Common case
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }

    return components as ChangeObject<ValueT>[];
  }
}
