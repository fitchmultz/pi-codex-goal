# Strict quality verification

This record covers adoption of engineering standard 5.2 from base `bb237d97d549c03308871a53ed47691dfdf408b2`. The [standard and exception comparisons](engineering-standard.md#pi-codex-goal-adoption-record) define the policy. CI artifacts identify the exact integrated source and host revisions.

## Required checks

`npm run check` runs these commands independently and fails if any command fails:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run policy:check
npm test
npm run test:quality
npm run pack:check
```

Local verification uses Node 24 on macOS with an isolated HOME, agent directory, and TMPDIR. TypeScript and oxlint-tsgolint do not publish Android binaries. Node behavior tests and Oxfmt also run on Termux. There is no emitted build. The dry run and existing native source, Git-production, and npm-artifact tests verify the shipped TypeScript package.

## Adoption controls

Disposable projects use the repository's actual configurations, compiler, native lint, and formatter. They contain no runtime dependencies on invalid fixtures. Each failing native control checks its diagnostic identity, file, location, and exit status against a passing counterpart.

| Protection                | Passing control                                                                        | Failing control                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Base and test composition | Valid production and test-support functions                                            | Explicit `no-explicit-any` and category-enabled `use-isnan` in both profiles                                                               |
| Unsafe types              | Narrow `unknown` before use                                                            | Unsafe assertion, JSON assignment, member access, and return                                                                               |
| Async work                | Await work and forward an unknown rejection                                            | Floating calls, async callbacks where void is expected, and known string rejection                                                         |
| Checked JavaScript        | Await a JSDoc-typed Promise                                                            | Unawaited call reports `no-floating-promises`                                                                                              |
| Compiler membership       | Valid TS and checked-JS assignments                                                    | Both reject a string assigned to a number with TS2322                                                                                      |
| Production structure      | Complexity 10, depth 3, parameters 4, statements 40, function lines 80, file lines 500 | Each corresponding limit plus one fails its exact rule                                                                                     |
| Test structure            | Complexity 15, depth 4, parameters 6, and a long test file                             | Complexity 16, depth 5, and parameters 7 fail                                                                                              |
| Node registrations        | Top-level and suite-body `nodeTest` registrations                                      | Context subtest, local namesake, wrong-origin import, test-body work, and unrelated work fail `no-floating-promises`                       |
| Directives                | The four authorized SDK operations                                                     | Copied, relocated, duplicated, unused, wrong-rule, or undocumented directives fail; strings remain unaffected                              |
| Policy                    | Appendix A and the documented mappings                                                 | A category-only rule disabled in configuration fails policy                                                                                |
| Coverage                  | New source enters native lint and compiler membership                                  | A maintained compiler input excluded by tsconfig, or a maintained lint input ignored through Git, fails policy                             |
| Aggregate status          | Clean copy passes before and after mutations                                           | Independent lint, semantic, compiler, formatter, test-assertion, and policy faults each fail `npm run check` while all gates still execute |

The native allowance and directive controls remain in `test/quality/native.test.ts`. Parser authorization and import-boundary controls remain in `test/type-hygiene.test.ts`. `test/quality/policy.test.ts` exercises the real policy command against configuration downgrades, new source discovery, compiler omissions, and strict-family relaxation. Ordinary edits do not rerun the full disposable adoption matrix.

There is no React, DOM, Jest, or Vitest context. There are no handwritten declarations or generated implementation files. The existing package-lock freshness checks use native npm, and native Pi consumer checks own host compatibility.

## Scope and retained settings

The base contains 87 maintained JS/TS files and no suppression comments or lint baseline. Its four `.mjs` scripts lack compiler ownership. They now run as checked `.ts` scripts, and workflow JavaScript lives in `scripts/release-verify-evidence.ts`. Workflow JSON-field reads use the Ubuntu runner's supplied `jq`.

The three API-contract exceptions are QX-001 for Node-owned test registration, QX-002 for Pi's two preparation assignments, and QX-003 for Pi's two five-argument tool callbacks. The comparisons include a real failed hook-scheduling run, failed preparation-copy consumers, and two compiler failures from the four-argument callback alternative. No unsafe-type or formatting exception is used.

`tsconfig.json` retains `skipLibCheck: true` for third-party declarations. There are no owned declarations to skip. Adding one fails coverage until its checked project is provided.

The [shared compatibility workflow](https://github.com/fitchmultz/.github/blob/8fa3c0629e895ed47a8e0e78d05a0d932c5a5793/.github/workflows/pi-compatibility.yml#L155-L156) retains the owner's Windows diagnostic-lane waiver at lines 155–156. Its Linux and macOS lanes remain required and run the full package acceptance. The shared qualifier itself returns a failure status on every platform. This change does not alter that separate, owner-waived platform policy or use it to suppress repository lint/compiler findings.
