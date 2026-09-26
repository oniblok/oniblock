// Tests assume the keeper's defaults. The root .env may carry production keeper settings (MODEL_MODE=oniblock1, ...);
// dotenv never overwrites a variable that is already set, and env() treats '' as unset, so pre-setting '' keeps .env
// from changing test behaviour. A variable exported for the test run itself is left alone. API keys still load.
const KEEPER_BEHAVIOUR = [
  'MODEL_MODE',
  'KEV_URL',
  'KEV_THRESHOLD_FILE',
  'TABULAR_MODEL_PATH',
  'CHARGE_THRESHOLD',
  'CHARGE_THRESHOLD_FALLBACK',
  'KEEPER_POST',
  'KEEPER_HEARTBEAT_BLOCKS',
  'KEEPER_FIRST_IN_BLOCK',
  'KEEPER_READ_LEAD_MS',
  'KEEPER_BLOCK_TIME_MS',
  'KEEPER_PRIORITY_GWEI',
  'ATTEST_BLOCK_OFFSET',
  'KEV_STATE_FORMAT',
];
for (const k of KEEPER_BEHAVIOUR) if (process.env[k] === undefined) process.env[k] = '';
