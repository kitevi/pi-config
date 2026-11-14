---
name: test-audit
description: "Find the tests that are safe to cut: ones whose checks cannot fail and ones that repeat another test. Use for 'which tests can I cut', 'audit these tests', or tests an agent just wrote. Reports only; never edits."
license: MIT (adapted from openclaw/openclaw test-audit; see LICENSE)
---

# Test audit

Find the tests that are safe to cut. A test earns its place by catching a bug no other test catches: a realistic mistake in the code under test that makes one of its checks fail. A test with no checks only checks that the code does not crash. Never edit, move, or delete anything, and never run the whole suite.

## Steps

1. Take the tests the user pointed at: single tests, files, or a directory. If they pointed at none, take the tests the current diff adds or changes, including untracked files. If that is empty too, reply "Name the tests to audit." and stop.
2. Read each test and the code it calls. Judge a test by its checks, not by its name.
3. Mark each test:
   - `cut` when its checks cannot fail: it compares a value with itself or with what the test or its mock supplied, or it runs none of the code under test;
   - `cut` when it repeats a test that stays: the same path through the code with the same or a weaker check, such as only that a result exists or has a type;
   - `keep` otherwise, and whenever you are unsure.
4. Stop after 20 tool calls and reply with what you have.

## Reply

- **Cut.** One line per test: `file:line`, its name, and the proof: the check quoted, or the `file:line` of the test that stays. If there are none, write "None found."
- **Close calls.** At most three kept tests, weakest first, one line each: `file:line`, its name, the bug it should catch, and the command that runs it. If there are none, write "None."
- **Kept.** How many tests stay, and any test files you did not reach.

Slow, ugly, badly named, or tied to internals is not a reason to cut. Leave out style, coverage numbers, and tests you would add.
