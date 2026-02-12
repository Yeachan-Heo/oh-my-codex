---
name: swarm
description: N coordinated agents on shared task list (compatibility facade over team)
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
