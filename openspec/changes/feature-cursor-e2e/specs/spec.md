# Specs

## Scenario S1
Given a repository with built `omx` CLI artifacts
When a user runs `omx mode cursor` and then `omx mode show`
Then mode state is persisted under `.omx/mode.json` and reported as `cursor`

## Scenario S2
Given a repository where `cursor-agent` is available in PATH
When a user runs `omx cursor apply <change-slug> --run --workspace . --model <model>`
Then OMX invokes Cursor agent command with the implementation prompt and exits with the child command status

## Scenario S3
Given a user runs `omx --help`
When command help is rendered
Then `omx cursor` and `omx mode` are listed with concise usage guidance

<NFR>
  <Latency p95_ms="200" p99_ms="500" />
  <Idempotency required="true" key="request_id" />
  <Concurrency strategy="single_process_cli" />
  <Degrade policy="no-op-guidance-with-nonzero-exit-on-failure" />
</NFR>
