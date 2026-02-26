import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESET,
  green,
  yellow,
  red,
  cyan,
  dim,
  bold,
  getRalphColor,
  getTodoColor,
  coloredBar,
  setColorEnabled,
  isColorEnabled,
  shouldEnableColorOutput,
} from '../colors.js';

const GREEN = '\x1b[32m';
const YELLOW_CODE = '\x1b[33m';
const RED_CODE = '\x1b[31m';
const CYAN_CODE = '\x1b[36m';
const DIM_CODE = '\x1b[2m';
const BOLD_CODE = '\x1b[1m';

afterEach(() => {
  setColorEnabled(true);
});

describe('RESET', () => {
  it('is the ANSI reset escape code', () => {
    assert.equal(RESET, '\x1b[0m');
  });
});

describe('green', () => {
  it('wraps text with green ANSI codes', () => {
    assert.equal(green('hello'), `${GREEN}hello${RESET}`);
  });

  it('handles empty string', () => {
    assert.equal(green(''), `${GREEN}${RESET}`);
  });

  it('starts with GREEN and ends with RESET', () => {
    const result = green('test');
    assert.ok(result.startsWith(GREEN));
    assert.ok(result.endsWith(RESET));
  });
});

describe('yellow', () => {
  it('wraps text with yellow ANSI codes', () => {
    assert.equal(yellow('warning'), `${YELLOW_CODE}warning${RESET}`);
  });

  it('handles empty string', () => {
    assert.equal(yellow(''), `${YELLOW_CODE}${RESET}`);
  });
});

describe('red', () => {
  it('wraps text with red ANSI codes', () => {
    assert.equal(red('error'), `${RED_CODE}error${RESET}`);
  });

  it('handles empty string', () => {
    assert.equal(red(''), `${RED_CODE}${RESET}`);
  });
});

describe('cyan', () => {
  it('wraps text with cyan ANSI codes', () => {
    assert.equal(cyan('info'), `${CYAN_CODE}info${RESET}`);
  });

  it('handles empty string', () => {
    assert.equal(cyan(''), `${CYAN_CODE}${RESET}`);
  });
});

describe('dim', () => {
  it('wraps text with dim ANSI codes', () => {
    assert.equal(dim('muted'), `${DIM_CODE}muted${RESET}`);
  });

  it('handles empty string', () => {
    assert.equal(dim(''), `${DIM_CODE}${RESET}`);
  });
});

describe('bold', () => {
  it('wraps text with bold ANSI codes', () => {
    assert.equal(bold('important'), `${BOLD_CODE}important${RESET}`);
  });

  it('handles empty string', () => {
    assert.equal(bold(''), `${BOLD_CODE}${RESET}`);
  });
});

describe('getRalphColor', () => {
  // With maxIterations=10: warningThreshold=7, criticalThreshold=9

  it('returns GREEN for low iterations', () => {
    assert.equal(getRalphColor(0, 10), GREEN);
    assert.equal(getRalphColor(6, 10), GREEN);
  });

  it('returns YELLOW at and above warning threshold', () => {
    // floor(10 * 0.7) = 7
    assert.equal(getRalphColor(7, 10), YELLOW_CODE);
    assert.equal(getRalphColor(8, 10), YELLOW_CODE);
  });

  it('returns RED at and above critical threshold', () => {
    // floor(10 * 0.9) = 9
    assert.equal(getRalphColor(9, 10), RED_CODE);
    assert.equal(getRalphColor(10, 10), RED_CODE);
  });

  it('handles the exact warning boundary', () => {
    // maxIterations=100: warning=70, critical=90
    assert.equal(getRalphColor(69, 100), GREEN);
    assert.equal(getRalphColor(70, 100), YELLOW_CODE);
  });

  it('handles the exact critical boundary', () => {
    assert.equal(getRalphColor(89, 100), YELLOW_CODE);
    assert.equal(getRalphColor(90, 100), RED_CODE);
  });

  it('handles floor rounding in thresholds', () => {
    // maxIterations=7: warning=floor(4.9)=4, critical=floor(6.3)=6
    assert.equal(getRalphColor(3, 7), GREEN);
    assert.equal(getRalphColor(4, 7), YELLOW_CODE);
    assert.equal(getRalphColor(6, 7), RED_CODE);
  });
});

describe('getTodoColor', () => {
  it('returns DIM when total is 0', () => {
    assert.equal(getTodoColor(0, 0), DIM_CODE);
    assert.equal(getTodoColor(5, 0), DIM_CODE);
  });

  it('returns GREEN when 80% or more is complete', () => {
    assert.equal(getTodoColor(8, 10), GREEN);   // 80%
    assert.equal(getTodoColor(10, 10), GREEN);  // 100%
    assert.equal(getTodoColor(9, 10), GREEN);   // 90%
  });

  it('returns YELLOW when 50% to 79% is complete', () => {
    assert.equal(getTodoColor(5, 10), YELLOW_CODE);    // 50%
    assert.equal(getTodoColor(7, 10), YELLOW_CODE);    // 70%
    assert.equal(getTodoColor(79, 100), YELLOW_CODE);  // 79%
  });

  it('returns CYAN when less than 50% is complete', () => {
    assert.equal(getTodoColor(0, 10), CYAN_CODE);    // 0%
    assert.equal(getTodoColor(4, 10), CYAN_CODE);    // 40%
    assert.equal(getTodoColor(49, 100), CYAN_CODE);  // 49%
  });

  it('handles single item fully completed', () => {
    assert.equal(getTodoColor(1, 1), GREEN);  // 100%
  });
});

describe('coloredBar', () => {
  it('returns a non-empty string', () => {
    const bar = coloredBar(50, 10);
    assert.ok(typeof bar === 'string' && bar.length > 0);
  });

  it('ends with RESET', () => {
    assert.ok(coloredBar(50, 10).endsWith(RESET));
    assert.ok(coloredBar(0, 10).endsWith(RESET));
    assert.ok(coloredBar(100, 10).endsWith(RESET));
  });

  it('uses GREEN for below 70%', () => {
    assert.ok(coloredBar(0, 10).startsWith(GREEN));
    assert.ok(coloredBar(69, 10).startsWith(GREEN));
  });

  it('uses YELLOW for 70% to 84%', () => {
    assert.ok(coloredBar(70, 10).startsWith(YELLOW_CODE));
    assert.ok(coloredBar(84, 10).startsWith(YELLOW_CODE));
  });

  it('uses RED for 85% or more', () => {
    assert.ok(coloredBar(85, 10).startsWith(RED_CODE));
    assert.ok(coloredBar(100, 10).startsWith(RED_CODE));
  });

  it('produces correct filled block count at 50% with default width', () => {
    const bar = coloredBar(50);
    // Math.round(0.5 * 10) = 5 filled
    assert.equal((bar.match(/█/g) || []).length, 5);
    assert.equal((bar.match(/░/g) || []).length, 5);
  });

  it('produces correct filled/empty counts for 40% width=10', () => {
    const bar = coloredBar(40, 10);
    // Math.round(0.4 * 10) = 4 filled, 6 empty
    assert.equal((bar.match(/█/g) || []).length, 4);
    assert.equal((bar.match(/░/g) || []).length, 6);
  });

  it('fills all blocks at 100%', () => {
    const bar = coloredBar(100, 10);
    assert.equal((bar.match(/█/g) || []).length, 10);
    assert.equal((bar.match(/░/g) || []).length, 0);
  });

  it('empties all blocks at 0%', () => {
    const bar = coloredBar(0, 10);
    assert.equal((bar.match(/█/g) || []).length, 0);
    assert.equal((bar.match(/░/g) || []).length, 10);
  });

  it('clamps percent above 100 to 100', () => {
    const bar = coloredBar(200, 10);
    assert.equal((bar.match(/█/g) || []).length, 10);
    assert.equal((bar.match(/░/g) || []).length, 0);
  });

  it('clamps percent below 0 to 0', () => {
    const bar = coloredBar(-50, 10);
    assert.equal((bar.match(/█/g) || []).length, 0);
    assert.equal((bar.match(/░/g) || []).length, 10);
  });

  it('treats non-finite percent as 0', () => {
    const bar = coloredBar(NaN, 10);
    assert.equal((bar.match(/█/g) || []).length, 0);
    assert.equal((bar.match(/░/g) || []).length, 10);
  });

  it('treats non-finite width as 0 – no blocks', () => {
    const bar = coloredBar(50, NaN);
    assert.equal((bar.match(/█/g) || []).length, 0);
    assert.equal((bar.match(/░/g) || []).length, 0);
  });

  it('handles zero width – no blocks', () => {
    const bar = coloredBar(50, 0);
    assert.equal((bar.match(/█/g) || []).length, 0);
    assert.equal((bar.match(/░/g) || []).length, 0);
  });
});

describe('color output toggles', () => {
  it('disables ANSI wrapping when setColorEnabled(false)', () => {
    setColorEnabled(false);
    assert.equal(isColorEnabled(), false);
    assert.equal(green('hello'), 'hello');
    assert.equal(dim('x'), 'x');
    assert.equal(coloredBar(50, 4), '██░░');
    assert.equal(getRalphColor(1, 10), '');
    assert.equal(getTodoColor(1, 2), '');
  });

  it('shouldEnableColorOutput returns false for non-tty/no-color/dumb term', () => {
    assert.equal(shouldEnableColorOutput(false, {}), false);
    assert.equal(shouldEnableColorOutput(true, { NO_COLOR: '1' }), false);
    assert.equal(shouldEnableColorOutput(true, { TERM: 'dumb' }), false);
  });

  it('shouldEnableColorOutput returns true for tty when color is allowed', () => {
    assert.equal(shouldEnableColorOutput(true, { TERM: 'xterm-256color' }), true);
  });
});
