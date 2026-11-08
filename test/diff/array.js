import {diffArrays} from '../../libesm/diff/array.js';

import {expect} from 'chai';

describe('diff/array', function() {
  describe('#diffArrays', function() {
    it('Should diff arrays', function() {
      const a = {a: 0}, b = {b: 1}, c = {c: 2};
      const diffResult = diffArrays([a, b, c], [a, c, b]);
      expect(diffResult).to.deep.equals([
          {count: 1, value: [a], removed: false, added: false},
          {count: 1, value: [b], removed: true, added: false},
          {count: 1, value: [c], removed: false, added: false},
          {count: 1, value: [b], removed: false, added: true}
      ]);
    });
    it('should diff falsey values', function() {
      const a = false;
      const b = 0;
      const c = '';
      // Example sequences from Myers 1986
      const arrayA = [a, b, c, a, b, b, a];
      const arrayB = [c, b, a, b, a, c];
      const diffResult = diffArrays(arrayA, arrayB);
      expect(diffResult).to.deep.equals([
        {count: 2, value: [a, b], removed: true, added: false},
        {count: 1, value: [c], removed: false, added: false},
        {count: 1, value: [b], removed: false, added: true},
        {count: 2, value: [a, b], removed: false, added: false},
        {count: 1, value: [b], removed: true, added: false},
        {count: 1, value: [a], removed: false, added: false},
        {count: 1, value: [c], removed: false, added: true}
      ]);
    });
    describe('anti-aliasing', function() {
      // Test apparent contract that no chunk value is ever an input argument.
      const value = [0, 1, 2];
      const expected = [
        {count: value.length, value: value, removed: false, added: false}
      ];

      const input = value.slice();
      const diffResult = diffArrays(input, input);
      it('returns correct deep result for identical inputs', function() {
        expect(diffResult).to.deep.equals(expected);
      });
      it('does not return the input array', function() {
        expect(diffResult[0].value).to.not.equal(input);
      });

      const input1 = value.slice();
      const input2 = value.slice();
      const diffResult2 = diffArrays(input1, input2);
      it('returns correct deep result for equivalent inputs', function() {
        expect(diffResult2).to.deep.equals(expected);
      });
      it('does not return the first input array', function() {
        expect(diffResult2[0].value).to.not.equal(input1);
      });
      it('does not return the second input array', function() {
        expect(diffResult2[0].value).to.not.equal(input2);
      });
    });
    it('Should not throw on non-string items when passed ignoreCase', function() {
      const a = {a: 0}, b = {a: 1}, c = {a: 2};
      expect(diffArrays([a, b], [a, b], { ignoreCase: true })).to.deep.equals([
          {count: 2, value: [a, b], removed: false, added: false}
      ]);
      expect(diffArrays([a, b], [a, c], { ignoreCase: true })).to.deep.equals([
          {count: 1, value: [a], removed: false, added: false},
          {count: 1, value: [b], removed: true, added: false},
          {count: 1, value: [c], removed: false, added: true}
      ]);
    });
    it('Should diff arrays with comparator', function() {
      const a = {a: 0}, b = {a: 1}, c = {a: 2}, d = {a: 3};
      function comparator(left, right) {
        return left.a === right.a;
      }
      const diffResult = diffArrays([a, b, c], [a, b, d], { comparator: comparator });
      expect(diffResult).to.deep.equals([
          {count: 2, value: [a, b], removed: false, added: false},
          {count: 1, value: [c], removed: true, added: false},
          {count: 1, value: [d], removed: false, added: true}
      ]);
    });
    it('Should pass old/new tokens as the left/right comparator args respectively', function() {
      diffArrays(
        ['a', 'b', 'c'],
        ['x', 'y', 'z'],
        {
          comparator: function(left, right) {
            expect(left).to.be.oneOf(['a', 'b', 'c']);
            expect(right).to.be.oneOf(['x', 'y', 'z']);
            return left === right;
          }
        }
      );
    });
    it('Should terminate early if execution time exceeds `timeout` ms', function() {
      // To test this, we also pass a comparator that hot sleeps as a way to
      // artificially slow down execution so we reach the timeout.
      function comparator(left, right) {
        const start = Date.now();
        // Hot-sleep for 10ms
        while (Date.now() < start + 10) {
          // Do nothing
        }
        return left === right;
      }

      // It will require 14 comparisons (140ms) to diff these arrays:
      const arr1 = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const arr2 = ['a', 'b', 'c', 'd', 'x', 'y', 'z'];

      // So with a timeout of 50ms, we are guaranteed failure:
      expect(diffArrays(arr1, arr2, {comparator, timeout: 50})).to.be.undefined;

      // But with a longer timeout, we expect success:
      expect(diffArrays(arr1, arr2, {comparator, timeout: 1000})).not.to.be.undefined;
    });

    describe('discarding tokens that have no match on the other side', function() {
      // Tokens are only discarded once the search has reached an edit length of at least 16, so
      // these inputs have plenty of tokens that occur on one side only.
      function range(prefix, n) {
        return Array.from({length: n}, (_, i) => prefix + i);
      }
      // A comparator turns discarding off, so this gives the result of a search over every token.
      function withoutDiscarding(a, b, options = {}) {
        return diffArrays(a, b, {...options, comparator: (l, r) => l === r});
      }

      it('makes diffing inputs with nothing in common fast', function() {
        // Without discarding, this takes billions of steps, so it would hit the timeout.
        const a = range('a', 20000), b = range('b', 20000);
        expect(diffArrays(a, b, {timeout: 1000})).to.deep.equal([
          {count: 20000, value: a, added: false, removed: true},
          {count: 20000, value: b, added: true, removed: false}
        ]);
      });

      it('puts removals of discarded tokens before additions', function() {
        // Without the padding, `FF` to `FG` diffs as `=F -F +G`.
        const a = ['F', 'F', ...range('o', 20)], b = ['F', 'G', ...range('n', 20)];
        expect(diffArrays(a, b)).to.deep.equal([
          {count: 1, value: ['F'], added: false, removed: false},
          {count: 21, value: ['F', ...range('o', 20)], added: false, removed: true},
          {count: 21, value: ['G', ...range('n', 20)], added: true, removed: false}
        ]);
      });

      it('matches tokens as early as a search over every token does', function() {
        const a = ['B', 'A', 'A', ...range('o', 20)], b = ['A', ...range('n', 20)];
        expect(diffArrays(a, b)).to.deep.equal([
          {count: 1, value: ['B'], added: false, removed: true},
          {count: 1, value: ['A'], added: false, removed: false},
          {count: 21, value: ['A', ...range('o', 20)], added: false, removed: true},
          {count: 20, value: range('n', 20), added: true, removed: false}
        ]);
      });

      it('interleaves discarded tokens with the rest of the diff', function() {
        const a = ['s', ...range('o', 10), 't', ...range('p', 10), 'u'],
              b = ['s', ...range('n', 10), 'u', ...range('m', 10), 't'];
        expect(diffArrays(a, b)).to.deep.equal([
          {count: 1, value: ['s'], added: false, removed: false},
          {count: 21, value: [...range('o', 10), 't', ...range('p', 10)], added: false, removed: true},
          {count: 10, value: range('n', 10), added: true, removed: false},
          {count: 1, value: ['u'], added: false, removed: false},
          {count: 11, value: [...range('m', 10), 't'], added: true, removed: false}
        ]);
      });

      it('gives the same result as a search over every token', function() {
        // A small linear congruential generator, so that the test is the same on every run.
        let seed = 42;
        function random(n) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          return seed % n;
        }
        const shared = {}, other = {};
        function token(alphabet, unmatchedPercent, prefix) {
          if (random(100) < unmatchedPercent) {
            return prefix + random(1e9);
          }
          return [shared, other, 1, 2, NaN][random(alphabet + 5)] ?? 't' + random(alphabet);
        }
        for (let i = 0; i < 300; i++) {
          const alphabet = 1 + random(20), unmatchedPercent = [5, 30, 60, 90][random(4)];
          const a = Array.from({length: 20 + random(150)}, () => token(alphabet, unmatchedPercent, 'o'));
          const b = random(2)
            ? a.map(t => (random(100) < unmatchedPercent ? token(alphabet, unmatchedPercent, 'n') : t))
            : Array.from({length: random(150)}, () => token(alphabet, unmatchedPercent, 'n'));
          for (const options of [{}, {oneChangePerToken: true}]) {
            expect(diffArrays(a, b, options)).to.deep.equal(withoutDiscarding(a, b, options));
          }
        }
      });

      describe('given options.maxEditLength', function() {
        // 20 discarded tokens, plus 4 edits to turn x s y into y s x.
        const a = ['x', 's', 'y', ...range('o', 10)], b = ['y', 's', 'x', ...range('n', 10)];
        const editLength = 24;

        it('returns the diff if it is short enough', function() {
          expect(diffArrays(a, b, {maxEditLength: editLength})).to.deep.equal(withoutDiscarding(a, b));
        });

        it('returns undefined if the diff is too long', function() {
          expect(diffArrays(a, b, {maxEditLength: editLength - 1})).to.be.undefined;
        });

        it('returns undefined if more tokens were discarded than allowed', function() {
          expect(diffArrays(a, b, {maxEditLength: 19})).to.be.undefined;
        });

        it('returns the diff if the only edits are of discarded tokens', function() {
          const c = range('o', 20), d = range('n', 20);
          expect(diffArrays(c, d, {maxEditLength: 40})).to.deep.equal(withoutDiscarding(c, d));
          expect(diffArrays(c, d, {maxEditLength: 39})).to.be.undefined;
        });

        it('calls back with the same results in async mode', function(done) {
          diffArrays(a, b, {maxEditLength: editLength, callback(diff) {
            expect(diff).to.deep.equal(withoutDiscarding(a, b));
            diffArrays(a, b, {maxEditLength: 19, callback(tooLong) {
              expect(tooLong).to.be.undefined;
              done();
            }});
          }});
        });
      });
    });
  });
});
