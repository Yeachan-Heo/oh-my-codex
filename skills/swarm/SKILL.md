---
name: swarm
description: "Launch N coordinated agents on a shared task list using the team pipeline. Use when you want parallel multi-agent execution and prefer the 'swarm' invocation style — compatibility alias for /team, triggered by 'swarm', 'coordinated swarm', or '/swarm N:agent-type'."
---

# Swarm (Compatibility Facade)

Swarm is a compatibility alias for the `/team` skill. All swarm invocations are routed to the Team skill's staged pipeline.

## Usage

```
/swarm N:agent-type "task description"
/swarm "task description"
```

## Behavior

This skill is identical to `/team`. Invoke the Team skill with the same arguments:

```
/team <arguments>
```

Follow the Team skill's full documentation for staged pipeline, agent routing, and coordination semantics.
