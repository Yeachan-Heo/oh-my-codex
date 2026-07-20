Release 0.18.13 after all verification and dogfooding are complete. Choose 0.19.0 only if repository evidence shows breaking/public API changes requiring a minor release; otherwise prepare and release 0.18.13 as the next patch after 0.18.12. Do not tag, publish, push, merge, or perform irreversible release actions until verification is clean and the final release action is explicitly safe from repository context.

@goal: Determine release version and scope
Inspect package metadata, changelog/release notes history, current repository changes, and recent commits/PR evidence to decide whether this is 0.18.13 or 0.19.0, and define the release scope.

@goal: Prepare release artifacts
Update versioned release artifacts for the selected version, including package metadata, changelog, release notes, readiness evidence, and any generated catalogs or mirrored bundles required by repository conventions.

@goal: Verify and dogfood release candidate
Run the focused and full verification lanes required for release readiness, including dogfooding the built CLI/package surfaces enough to prove the release candidate works.

@goal: Complete safe release handoff
Produce the final release readiness handoff with exact verification evidence and identify the remaining irreversible release command(s) that require maintainer execution or explicit approval.
