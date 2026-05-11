# @creadev.org/network

> Network - HTTP, SSE, fetch

[![npm](https://img.shields.io/npm/v/@creadev.org/network)](https://www.npmjs.com/package/@creadev.org/network)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

```bash
npm install @creadev.org/network
```

## Usage

```typescript
import { NetworkClient, createNetwork, fetch, sse } from '@creadev.org/network';

const client = createNetwork();
const data = await fetch('https://api.example.com/data');
const stream = sse('https://api.example.com/stream');
```

## API

| Function | Description |
|----------|-------------|
| `createNetwork(options?)` | Create network client |
| `fetch(url, options?)` | Fetch with retry |
| `sse(url)` | Server-sent events |

## License

MIT
