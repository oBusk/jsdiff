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

    const newLen = newTokens.length, oldLen = oldTokens.length;
    let maxEditLength = newLen + oldLen;
    if(options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = options.timeout ?? Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;

    // Tokens are compared in normalized form, but the returned change objects are built from the
    // original tokens.
    const oldNormalized = oldTokens.map(token => this.normalizeToken(token, options)),
          newNormalized = newTokens.map(token => this.normalizeToken(token, options));

    // Seed editLength = 0, i.e. the content starts with the same values
    const initialPath: Path = { oldPos: -1, lastComponent: undefined };
    let newPos = this.extractCommon(initialPath, newNormalized, oldNormalized, 0, options);
    if (initialPath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      // The texts are identical (per the definition of "identical" implied by
      // tokenize, normalizeToken, and equals).
      return done(this.buildValues(initialPath.lastComponent, newTokens, oldTokens));
    }

    // bestPath[offset + k] holds the furthest-reaching path on diagonal k = oldPos - newPos.
    // Positions range over -1 <= oldPos < oldLen and -1 <= newPos < newLen, so the edit graph has
    // the oldLen + newLen + 1 diagonals -newLen..oldLen, and the loop below never leaves them (see
    // the comment on the band in execEditLength). The loop also reads k - 1 and k + 1, hence
    // one spare slot on each side. Diagonals go negative, and JavaScript engines store negative
    // array indices as ordinary named properties rather than as array elements, which would make
    // every lookup in the loop a slow dictionary access; the offset keeps every index within
    // [0, oldLen + newLen + 2].
    const offset = newLen + 1;
    const bestPath: Path[] = new Array(oldLen + newLen + 3);
    bestPath[offset] = initialPath;

    // Every path starts on diagonal 0 and ends on finalDiagonal, and each edit moves it to a
    // neighbouring diagonal. So |finalDiagonal| edits are forced, and every other edit is a
    // detour away from finalDiagonal that costs one more edit to undo. That makes
    // editLength = |finalDiagonal| + 2 * (number of detours).
    //
    // Myers's algorithm runs one round per edit. Like "An O(NP) Sequence Comparison Algorithm"
    // (Wu, Manber, Myers & Miller, 1990), we run one round per detour instead, trying
    // editLength = |finalDiagonal|, then +2, +4, ..., and in each round we only compute paths
    // that can still reach the end within editLength edits.
    //
    // Every path we compute is one Myers's algorithm also computes, built from the same
    // neighbours with the same tie-break, so the result is identical; we just skip paths that
    // can't finish in time. This takes O((N+M)(P+1)) time instead of O((N+M)D), where P is the
    // number of insertions or of deletions in the result, whichever is smaller. So diffs that
    // mostly insert or mostly delete finish in a single round.
    const finalDiagonal = oldLen - newLen;

    // The forced edits. Every editLength we try is this plus an even number.
    const minEditLength = Math.abs(finalDiagonal);
    let editLength = minEditLength;

    // One round: extend every path that can still reach the end within editLength edits.
    // Returns the result as soon as one does.
    const execEditLength = () => {
      // The band: every diagonal from 0 to finalDiagonal, widened by one diagonal on each side
      // per detour. It never leaves the edit graph, since editLength <= oldLen + newLen.
      let lowestDiagonal = (finalDiagonal - editLength) / 2,
          highestDiagonal = (finalDiagonal + editLength) / 2;
      if (editLength === minEditLength) {
        // In the first round, diagonal 0 is the seed path, which is already computed.
        if (finalDiagonal >= 0) {
          lowestDiagonal++;
        } else {
          highestDiagonal--;
        }
      }

      // Walk toward finalDiagonal from both ends of the band: up from lowestDiagonal, then down
      // from highestDiagonal, finishing on finalDiagonal. A move toward finalDiagonal is forced,
      // so it can extend a path computed earlier in this round; a move away from it is a detour,
      // so it extends a path from the previous round. finalDiagonal comes last because both of
      // its neighbours are computed this round.
      const diagonalsBelowFinal = finalDiagonal - lowestDiagonal;
      for (let i = 0; i <= highestDiagonal - lowestDiagonal; i++) {
        // i counts diagonals in that order; map it to the diagonal number k.
        let k;
        if (i < diagonalsBelowFinal) {
          k = lowestDiagonal + i;
        } else {
          k = highestDiagonal - (i - diagonalsBelowFinal);
        }

        let basePath;
        const removePath = bestPath[offset + k - 1],
              addPath = bestPath[offset + k + 1];

        const canAdd = addPath && addPath.oldPos - k < newLen;
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          // Both moves onto k would leave the edit graph, so no path ends on k this round.
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
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[offset + k] = basePath;
        }
      }

      editLength += 2;
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

          if (!execEditLength()) {
            exec();
          }
        });
      }());
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
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
      return token.toLowerCase() as TokenT;
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
    oldTokens: TokenT[]
  ): ChangeObject<ValueT>[] {
    // First we convert our linked list of components in reverse order to an
    // array in the right order:
    const components: DraftChangeObject[] = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();

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
