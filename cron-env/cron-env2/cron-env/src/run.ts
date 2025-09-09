import { getAllEnv } from './lib/env';

// Allow running specific functions from the command line
const arg = process.argv[2];

switch (arg) {
  case 'get':
    const envList = getAllEnv();
    console.log('envList', envList);
    break;
  default:
    console.error(`Unknown function: ${arg}`);
    process.exit(1);
}
