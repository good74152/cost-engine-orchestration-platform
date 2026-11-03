# Documentation guide

## Start here

| If you want to | Read |
|---|---|
| See what the project does | [README](../README.md) |
| Understand the rules and locks | [Architecture](ARCHITECTURE.md) |
| Follow each flow step by step | [Engineering Flows](ENGINEERING_FLOWS.md) |
| Know why a decision was made | [Architecture decisions](adr/README.md) |
| Look up routes, setup and test gates | [Backend Reference](REFERENCE.md) |
| See what is done and what is deferred | [Roadmap](ROADMAP.md) |

## Operate the demo

| Document | Purpose |
|---|---|
| [Deployment](DEPLOYMENT.md) | Full deployment and safety contract |
| [Recovery drill](RECOVERY_DRILL.md) | Restore a backup into an isolated database and assess it |
| [Recovery readiness](RECOVERY_READINESS.md) | Evaluate retained backup and drill evidence offline |

## Project history

These record what was asked and proved at the time, and may describe things that have since changed. Where they disagree with the documents above, the documents above are current.

| Folder | Contents |
|---|---|
| [Task specifications](tasks/) | Scope and contracts for each bounded change |
| [Verification reports](verification/) | Recorded test runs and their source revisions |
| [Final acceptance](verification/task-007-final-acceptance.md) | Orchestration Core v2 acceptance and its limits |

To change the flow diagrams, see [the diagram sources](diagrams/flows/README.md). To change the repository, follow the [engineering policy](../AGENTS.md).
