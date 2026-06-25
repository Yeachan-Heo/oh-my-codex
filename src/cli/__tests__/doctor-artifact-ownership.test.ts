import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	checkRepoArtifactOwnership,
	repairRepoArtifactOwnership,
} from "../doctor.js";

describe("repo artifact ownership doctor check", () => {
	it("reports root-owned files under .omx/plans with exact remediation guidance", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-artifacts-"));
		try {
			const artifact = join(wd, ".omx", "plans", "root-owned.md");
			await mkdir(join(wd, ".omx", "plans"), { recursive: true });
			await writeFile(artifact, "# plan\n");

			const check = await checkRepoArtifactOwnership(wd, {
				currentUid: 1000,
				statPath: async (path) => {
					const info = await lstat(path);
					if (path === artifact) {
						return new Proxy(info, {
							get(target, property, receiver) {
								if (property === "uid") return 0;
								if (property === "gid") return 0;
								return Reflect.get(target, property, receiver);
							},
						});
					}
					return info;
				},
			});

			assert.equal(check.status, "warn");
			assert.match(check.message, /\.omx[\\/]plans[\\/]root-owned\.md \(root-owned uid=0 gid=0\)/);
			assert.match(check.message, /sudo chown -R \$\(id -u\):\$\(id -g\)/);
			assert.match(check.message, /omx doctor --force/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not warn about root-owned repo artifacts when doctor runs as root", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-artifacts-"));
		try {
			const artifact = join(wd, ".omx", "plans", "root-owned.md");
			await mkdir(join(wd, ".omx", "plans"), { recursive: true });
			await writeFile(artifact, "# plan\n");

			const check = await checkRepoArtifactOwnership(wd, {
				currentUid: 0,
				currentGid: 0,
				statPath: async (path) => {
					const info = await lstat(path);
					if (path === artifact) {
						return new Proxy(info, {
							get(target, property, receiver) {
								if (property === "uid") return 0;
								if (property === "gid") return 0;
								return Reflect.get(target, property, receiver);
							},
						});
					}
					return info;
				},
			});

			assert.equal(check.status, "pass");
			assert.equal(
				check.message,
				"repo-local .omx/.beads artifacts are writable by the current user",
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports owner-mismatched files for non-root doctor runs", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-artifacts-"));
		try {
			const artifact = join(wd, ".beads", "state.json");
			await mkdir(join(wd, ".beads"), { recursive: true });
			await writeFile(artifact, "{}\n");

			const check = await checkRepoArtifactOwnership(wd, {
				currentUid: 1000,
				statPath: async (path) => {
					const info = await lstat(path);
					if (path === artifact) {
						return new Proxy(info, {
							get(target, property, receiver) {
								if (property === "uid") return 1001;
								if (property === "gid") return 1001;
								return Reflect.get(target, property, receiver);
							},
						});
					}
					return info;
				},
			});

			assert.equal(check.status, "warn");
			assert.match(check.message, /\.beads[\\/]state\.json \(owner-mismatch uid=1001 gid=1001\)/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("reports non-writable files under repo-local artifact directories", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-artifacts-"));
		try {
			const artifact = join(wd, ".beads", "state.json");
			await mkdir(join(wd, ".beads"), { recursive: true });
			await writeFile(artifact, "{}\n");
			const currentUid = 1000;
			const currentGid = 1000;
			const check = await checkRepoArtifactOwnership(wd, {
				currentUid,
				accessPath: async (path) => {
					if (path === artifact) throw new Error("not writable");
				},
				statPath: async (path) => {
					const info = await lstat(path);
					return new Proxy(info, {
						get(target, property, receiver) {
							if (property === "uid") return currentUid;
							if (property === "gid") return currentGid;
							return Reflect.get(target, property, receiver);
						},
					});
				},
			});

			assert.equal(check.status, "warn");
			assert.match(check.message, /\.beads[\\/]state\.json \(not-writable uid=\d+ gid=\d+\)/);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("repairs only when the repo root is owned by the current user", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-doctor-artifacts-"));
		try {
			const artifact = join(wd, ".omx", "plans", "root-owned.md");
			await mkdir(join(wd, ".omx", "plans"), { recursive: true });
			await writeFile(artifact, "# plan\n");
			const calls: string[] = [];
			const ownerUid = 1000;
			const ownerGid = 1000;

			const repaired = await repairRepoArtifactOwnership(wd, {
				currentUid: ownerUid,
				currentGid: ownerGid,
				statPath: async (path) => {
					const info = await lstat(path);
					return new Proxy(info, {
						get(target, property, receiver) {
							if (property === "uid") return path === artifact ? 0 : ownerUid;
							if (property === "gid") return path === artifact ? 0 : ownerGid;
							return Reflect.get(target, property, receiver);
						},
					});
				},
				chownPath: async (path, uid, gid) => {
					calls.push(`${path}:${uid}:${gid}`);
				},
			});

			assert.equal(repaired.repaired, 1);
			assert.deepEqual(repaired.skipped, []);
			assert.deepEqual(calls, [`${artifact}:${ownerUid}:${ownerGid}`]);

			const nonWritable = await repairRepoArtifactOwnership(wd, {
				currentUid: ownerUid,
				currentGid: ownerGid,
				statPath: async (path) => {
					const info = await lstat(path);
					return new Proxy(info, {
						get(target, property, receiver) {
							if (property === "uid") return ownerUid;
							if (property === "gid") return ownerGid;
							return Reflect.get(target, property, receiver);
						},
					});
				},
				accessPath: async (path) => {
					if (path === artifact) throw new Error("not writable");
				},
				chownPath: async () => {
					assert.fail("writability-only repair should not call chown");
				},
			});

			assert.equal(nonWritable.repaired, 0);
			assert.deepEqual(nonWritable.skipped, [".omx/plans/root-owned.md: not writable by current user"]);

			const blocked = await repairRepoArtifactOwnership(wd, {
				currentUid: ownerUid,
				currentGid: ownerGid,
				statPath: async (path) => {
					const info = await lstat(path);
					return new Proxy(info, {
						get(target, property, receiver) {
							if (property === "uid") return ownerUid + 1;
							if (property === "gid") return ownerGid;
							return Reflect.get(target, property, receiver);
						},
					});
				},
				chownPath: async () => {
					assert.fail("unsafe repair should not call chown");
				},
			});

			assert.equal(blocked.repaired, 0);
			assert.deepEqual(blocked.skipped, ["repo root is not owned by the current user"]);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
