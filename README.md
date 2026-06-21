# pi-tasked-subagents

Plan-first subagent orchestration for Pi.

`pi-tasked-subagents` lets Pi store a validated plan, split it into phases and tasks, dispatch one task per background subagent, and collect criterion-based evidence before marking work complete.

## Install

Install from GitHub:

```bash
pi install git:github.com/bnema/pi-tasked-subagents
```

Install from a local checkout:

```bash
pi install /path/to/pi-tasked-subagents
```

For local development:

```bash
pi -e /path/to/pi-tasked-subagents
```

## Plugin path

The Pi extension entrypoint is:

```text
./extensions/index.ts
```

It is declared in `package.json` as:

```json
{
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

## Use

```text
/tasked-subagents help
/tasked-subagents status
/tasked-subagents dispatch
/tasked-subagents agents
```

The model tool is named `tasked_subagents`.

## Develop

```bash
npm install
npm run verify
pi -e .
```
