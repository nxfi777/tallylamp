# Tallylamp launch plan

Prepared 6 September 2026. This plan tracks the work needed for a public release. The website and marketplace template still need to be built,
tested, and published.

## Repository decision

Keep one main open-source repository. Decide which history can be public before
publishing it. The runtime,
Dockerfile, public deployment configuration, tests, and documentation belong here.
A second cleaned copy would need every bug fix and release kept in sync.

Project constraints and local cleanup instructions live in
[`docs/contributing.md`](contributing.md). Keep the repository root free of
`AGENTS.md` and `CLAUDE.md`. Personal agent preferences and machine configuration
belong in local tooling settings or Git's local exclude file.

The tracked `.github/workflows/test.yml` runs checks; it contains no personal
Railway deployment job. Keep it. The existing personal service is connected
directly to this repository's `main` branch in Railway. That connection lives
outside the workflow; Railway currently has its CI-wait setting disabled.
Store deployment credentials and target IDs in the hosting platform or protected
GitHub environment settings. If a deploy workflow is added later, restrict it to
the canonical repository and intended branch. Pull requests should run tests.
See [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

The 6 September history review covered 49 commits across all fetched refs.
Gitleaks found no credentials, but an older `.env.example` contains the live
personal deployment hostname. Historical commits also retain the former root
instruction files and author names and email addresses. Removing files in a new
commit leaves their earlier versions in history. Decide whether those records
can be public before publishing the history. No history rewrite has been made.
GitHub deployment and check metadata was not accessible anonymously and remains
unverified; it can contain links outside the Git file history.

## Positioning

Start with developers using MCP agents on sites that require a login or occasional
human input. Lead with the handoff and the saved browser profile. Advanced tools
such as recording, profile cloning, and tunnels can follow in the documentation.

Suggested website headline:

> Give your AI agent a browser you can watch and take over.

Suggested supporting copy:

> Keep a Chrome profile for your agent. Watch it work, step in to sign in, then
> hand it back. Open source. Runs on your server.

The business-library basis is Alex Hormozi's *$100M Offers*, "Value Offer: The
Value Equation," especially reducing time delay and effort. Applied here, that
means a working deploy template and a short path to the first browser handoff.
His *Proof Checklist*, "Belief Continuum" and "How I Make Proof More Compelling,"
support showing what the product does before making broader claims.
These ideas guide the launch. Demand for Tallylamp still needs to be tested.

Make a short real recording with an agent opening a page, a person taking control,
and the agent continuing afterward. Use a test account. Show profile persistence
across a restart in a second clip or an unambiguous edited sequence. Do not promise
a setup time or monthly bill until a fresh install has been measured.

## Release work in order

1. Finish and verify the repository preparation. The README now has setup and
   connection instructions; longer operating notes live in `docs/usage.md`.
   The realism CI job now invokes `npm run test:realism`, and the unit job builds
   TypeScript before testing. Verify the full CI run on Linux.
2. Verify the checkout-based CLI workflow on a fresh clone. `package.json` is
   private, and tool-generated instructions already use `node bin/tallylamp.mjs`.
   The user guide now matches that command instead of the README's old
   `npx tallylamp` example. Open-source licensing does not require npm publication;
   a published CLI can be a later convenience.
3. Create a clean Railway test project from the public source. Apply the settings
   in `docs/railway.md`: one service, `/data` volume, port 8080, healthcheck, a
   generated secret in the template, and an initial cap of two browsers. Verify
   the IaC configuration with Railway; its checked-in description alone is not
   proof that all template settings are applied.
4. Create an unpublished template and deploy it into a fresh project. Test a real
   agent connection, a login, watch, takeover, return, stop/start, and redeploy
   persistence. Check revocation and memory under the intended browser cap.
   Record the client versions tested and any compatibility gaps.
5. Configure a backup and verify a restore on test data. Give `SECURITY.md` a
   private reporting route to the project maintainer; it currently directs
   reports only to the deployment operator.
6. Build the website and record the demo using the tested release. Keep the
   site in a `site/` directory in this repository with its own build and hosting
   configuration. Serve it separately from the authenticated browser dashboard.
7. Publish the template, replace draft links with its actual deploy URL, and
   release the website. Tag the tested application revision and document how
   operators update. Verify the public links and a fresh deployment afterward.

Railway supports template creation and publication through its dashboard and
[CLI](https://docs.railway.com/cli/templates). Each deployed template should get
its own secret through a [template variable function](https://docs.railway.com/templates/create).
Creation and marketplace publication are separate steps.

## Website brief

The page should answer what Tallylamp does, show it working, and help someone
deploy their own instance. Use a static site; the marketing page needs no user
database, account system, or connection to the private browser fleet.

The first screen should show the headline, a real product screenshot or recording,
and a primary "Deploy on Railway" action. Give "View source" a secondary link.
Follow with the handoff demonstration and brief setup steps. Explain persistence,
agent ownership, and permissions where they help someone decide to use it.

Put a short FAQ near the deploy action: hosting costs depend on usage,
Chrome needs memory, profiles need a volume, redeploys interrupt active browsers,
and sites may reject automation. Link to setup, compatibility, security, and the
MIT license. Avoid an interactive public admin demo backed by personal profiles.

Use the existing product identity after reviewing the icon and dashboard. A
responsive, accessible page and a clear demonstration are enough for the first
release. A pricing table or paid plan is outside this open-source launch.

Track successful fresh deployments, first completed handoffs, and setup problems
reported by users. GitHub stars can show interest, but they do not
show whether someone got a browser working.
