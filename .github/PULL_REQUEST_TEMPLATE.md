## Outcome

Describe the user-visible or operator-visible result.

## Safety and architecture

Explain changes to credentials, trust boundaries, Cloudflare API permissions, persistence, migrations, write planning, or verification. Write "None" when the change does not affect them.

## Verification

- [ ] Focused tests pass
- [ ] `npm test` passes
- [ ] Relevant Playwright journeys pass
- [ ] Hosted assets and Worker dry-run pass when affected
- [ ] Documentation artifact and Worker dry-run pass when affected
- [ ] `npm run check:publication` passes
- [ ] Public screenshots were regenerated and inspected when visible behavior changed

## Publication hygiene

- [ ] No live account identifiers, operator domains, credentials, operator files, audit results, traces, or real-account screenshots are included
- [ ] Documentation uses portable relative links
