import assert from 'assert';
import { MongoClient } from 'mongodb';
import pino from 'pino';
import util from 'util';
import { EnvironmentVariableConfigurationManager } from './configuration_manager.js';
import { MongoAcceptedSwapStore } from './dependencies/accepted_swap_store.js';
import { BinanceApi } from './dependencies/binance/binance_api.js';
import { BinanceTrading, IBinanceTradingConfig } from './dependencies/binance/binance_trading.js';
import { MongoCreatedSwapStore } from './dependencies/created_swap_store.js';
import { GalaSwapApi } from './dependencies/galaswap/galaswap_api.js';
import { GalaChainRouter } from './dependencies/onchain/galachain_router.js';
import { MongoPriceStore } from './dependencies/price_store.js';
import {
  ConsoleStatusReporter,
  DiscordStatusReporter,
  IStatusReporter,
  SlackWebhookStatusReporter,
} from './dependencies/status_reporters.js';
import { BasicSwapAccepterStrategy } from './strategies/basic_swap_accepter/basic_swap_accepter_strategy.js';
import { BasicSwapCreatorStrategy } from './strategies/basic_swap_creator/basic_swap_creator_strategy.js';
import { BinanceTradingStrategy } from './strategies/binance_trading/binance_trading_strategy.js';
import { ArbitrageStrategy } from './strategies/arbitrage/arbitrage_strategy.js';
import { mainLoop } from './tick_loop.js';
import { defaultTokenConfig } from './token_config.js';
import { ILogger } from './types/types.js';
import './utils/big_number_safety_extensions.js';

const sleep = util.promisify(setTimeout);

// BinanceTradingStrategy will be initialized after binanceTrading is set up
let binanceTradingStrategy: BinanceTradingStrategy | null = null;

async function main(logger: ILogger) {
  const configuration = new EnvironmentVariableConfigurationManager();

  /* Settings */

  const loopWaitMsString = await configuration.getOptionalWithDefault('LOOP_WAIT_MS', '15000');
  const mongoUri = await configuration.getRequired('MONGO_URI');
  const selfWalletAddress = await configuration.getRequired('GALA_WALLET_ADDRESS');
  const selfPrivateKey = await configuration.getRequired('GALA_PRIVATE_KEY');
  const slackInfoWebhookUri = await configuration.getOptional('SLACK_WEBHOOK_URI');
  const slackAlertWebhookUri =
    (await configuration.getOptional('SLACK_ALERT_WEBHOOK_URI')) ?? slackInfoWebhookUri;
  const discordInfoWebhookUri = await configuration.getOptional('DISCORD_WEBHOOK_URI');
  const discordAlertWebhookUri =
    (await configuration.getOptional('DISCORD_ALERT_WEBHOOK_URI')) ?? discordInfoWebhookUri;

  // GalaSwap API - Updated 2025 GalaChain API
  // Uses the new GalaChain 2.0 API endpoints (/v1/token-contract/, etc.)
  const galaSwapApiBaseUri = await configuration.getOptionalWithDefault(
    'GALASWAP_API_BASE_URI',
    'https://api-galaswap.gala.com', // Updated 2025 GalaChain Gateway API
  );

  // GalaSwap API timeout configuration
  const galaSwapRequestTimeoutMs = Number(
    await configuration.getOptionalWithDefault('GALASWAP_REQUEST_TIMEOUT_MS', '30000'),
  );
  const galaSwapConnectTimeoutMs = Number(
    await configuration.getOptionalWithDefault('GALASWAP_CONNECT_TIMEOUT_MS', '15000'),
  );


  // Blockchain RPC Provider (MANDATORY for on-chain trading)
  // Used for: swap transactions via GalaChain chaincode contracts
  const galaRpcUrl = await configuration.getOptionalWithDefault(
    'GALA_RPC_URL',
    'https://rpc.gala.com', // Primary RPC endpoint
  );
  
  // GalaChain Chaincode Contract Name (REQUIRED for on-chain trading)
  // Default: "galachain-gala-swap" (official GalaSwap contract)
  const galaSwapContractName = await configuration.getOptionalWithDefault(
    'GALASWAP_CONTRACT_NAME',
    'galachain-gala-swap',
  );

  // Binance configuration
  const binanceEnabled = (await configuration.getOptionalWithDefault('BINANCE_ENABLED', 'false')) === 'true';
  const binanceApiBaseUri = await configuration.getOptionalWithDefault(
    'BINANCE_API_BASE_URI',
    'https://api.binance.com',
  );
  const binanceApiKey = await configuration.getOptional('BINANCE_API_KEY');
  const binanceApiSecret = await configuration.getOptional('BINANCE_API_SECRET');

  const executionDelayEnvVar = await configuration.getOptionalWithDefault(
    'EXECUTION_DELAY_MS',
    '0',
  );

  const ignoreSwapsCreatedBeforeEnvVar = await configuration.getOptionalWithDefault(
    'IGNORE_SWAPS_CREATED_BEFORE',
    '0',
  );

  const delayBeforeExecuteMs = Number(executionDelayEnvVar);
  assert(
    Number.isInteger(delayBeforeExecuteMs) && delayBeforeExecuteMs >= 0,
    'EXECUTION_DELAY_MS must be a positive integer',
  );

  const ignoreSwapsCreatedBefore = new Date(ignoreSwapsCreatedBeforeEnvVar);
  assert(
    ignoreSwapsCreatedBefore.getTime() >= 0,
    'IGNORE_SWAPS_CREATED_BEFORE must be a valid date',
  );

  const loopWaitMs = Number(loopWaitMsString);
  assert(
    Number.isInteger(loopWaitMs) && loopWaitMs >= 0,
    'LOOP_WAIT_MS must be a non-negative integer',
  );

  /* End of sehttps://dex-backend-prod1.defi.gala.comttings */

  /* Dependencies */

  const mongoClient = new MongoClient(mongoUri);
  const db = mongoClient.db();
  const createdSwapStore = new MongoCreatedSwapStore(db);
  const acceptedSwapStore = new MongoAcceptedSwapStore(db);
  const priceStore = new MongoPriceStore(db);

  await Promise.all([createdSwapStore.init(), acceptedSwapStore.init(), priceStore.init()]);

  // Initialize GalaChain Router for direct chaincode contract trading
  // Uses Token Class Keys (not hex addresses) and chaincode contracts
  // Contract Name: "galachain-gala-swap" (official GalaSwap contract)
  // MUST be initialized before GalaSwapApi so it can be passed to it
  const galaChainRouter = galaRpcUrl
    ? new GalaChainRouter(
        galaRpcUrl,
        selfWalletAddress,
        selfPrivateKey,
        logger,
        galaSwapContractName,
      )
    : null;

  if (galaChainRouter) {
    logger.info(
      {
        rpcUrl: galaRpcUrl,
        contractName: galaChainRouter.getContractName(),
        walletAddress: galaChainRouter.getWalletAddress(),
      },
      'GalaChain router initialized for direct chaincode contract trading (using Token Class Keys)',
    );
  } else {
    logger.warn(
      {
        hasRpcUrl: !!galaRpcUrl,
      },
      'GalaChain router not initialized - RPC URL required',
    );
  }

  const galaSwapApi = new GalaSwapApi(
    galaSwapApiBaseUri,
    selfWalletAddress,
    selfPrivateKey,
    fetch,
    logger,
    {
      requestTimeoutMs: galaSwapRequestTimeoutMs,
      connectTimeoutMs: galaSwapConnectTimeoutMs,
      galaChainRouter: galaChainRouter ?? null,
    },
  );


  // Initialize Binance API if enabled
  let binanceApi: BinanceApi | null = null;
  if (binanceEnabled) {
    if (!binanceApiKey || !binanceApiSecret) {
      logger.warn(
        'BINANCE_ENABLED=true but BINANCE_API_KEY or BINANCE_API_SECRET not provided. Binance integration will be disabled.',
      );
    } else {
      binanceApi = new BinanceApi(binanceApiBaseUri, binanceApiKey, binanceApiSecret, fetch, logger);
      logger.info({
        baseUri: binanceApiBaseUri,
        hasApiKey: !!binanceApiKey,
        hasApiSecret: !!binanceApiSecret,
      }, 'Binance API enabled and initialized');
    }
  }

  // Initialize Binance Trading
  // Note: binanceTrading is needed for arbitrage strategy even if general trading is disabled
  let binanceTrading: BinanceTrading | null = null;
  if (binanceApi && binanceApiKey && binanceApiSecret) {
    // Always initialize binanceTrading if API is available (needed for arbitrage)
    // Use config values if available, otherwise use defaults
    const tradingConfig: IBinanceTradingConfig = {
      enabled: defaultTokenConfig.binance?.trading?.enabled ?? false,
      minTradeAmount: defaultTokenConfig.binance?.trading?.minTradeAmount ?? 10,
      maxTradeAmount: defaultTokenConfig.binance?.trading?.maxTradeAmount ?? 10000,
      defaultOrderType: defaultTokenConfig.binance?.trading?.defaultOrderType ?? 'MARKET',
      tradingPairs: defaultTokenConfig.binance?.trading?.tradingPairs?.map((p: { baseAsset: string; quoteAsset: string; symbol: string; minNotional?: number | undefined }) => {
        const pair: { baseAsset: string; quoteAsset: string; symbol: string; minNotional?: number } = {
          baseAsset: p.baseAsset,
          quoteAsset: p.quoteAsset,
          symbol: p.symbol,
        };
        if (p.minNotional !== undefined) {
          pair.minNotional = p.minNotional;
        }
        return pair;
      }) ?? [],
    };
    binanceTrading = new BinanceTrading(binanceApi, tradingConfig, logger);
    logger.info({
      enabled: tradingConfig.enabled,
      tradingPairs: tradingConfig.tradingPairs.length,
      minTradeAmount: tradingConfig.minTradeAmount,
      maxTradeAmount: tradingConfig.maxTradeAmount,
      note: tradingConfig.enabled ? 'General trading enabled' : 'Initialized for arbitrage only',
    }, 'Binance trading initialized');

    // Initialize BinanceTradingStrategy only if general trading is enabled
    if (defaultTokenConfig.binance?.trading?.enabled) {
      const strategyConfig = {
        enabled: tradingConfig.enabled,
        defaultTradeAmount: 10, // Default $10 trades
        tradingPairs: tradingConfig.tradingPairs.map((p) => {
          const pair: { baseAsset: string; quoteAsset: string; symbol: string; tradeAmount: number; minNotional?: number } = {
            baseAsset: p.baseAsset,
            quoteAsset: p.quoteAsset,
            symbol: p.symbol,
            tradeAmount: 10, // $10 per pair (can be customized per pair in config)
          };
          if (p.minNotional !== undefined) {
            pair.minNotional = p.minNotional;
          }
          return pair;
        }),
        maxTradesPerHour: 10, // Max 10 trades per hour per pair
      };
      binanceTradingStrategy = new BinanceTradingStrategy(strategyConfig);
      logger.info({
        tradingPairs: strategyConfig.tradingPairs.length,
        pairs: strategyConfig.tradingPairs.map((p) => p.symbol),
      }, 'BinanceTradingStrategy initialized with trading pairs');
    } else {
      logger.info('Binance trading disabled in config - only arbitrage strategy will use Binance');
    }
  } else if (binanceApi) {
    logger.warn('Binance API is available but API key/secret not provided. Arbitrage strategy will not work.');
  }

  // Initialize strategies
  // For now, only run arbitrage strategy - other trading pairs disabled
  const strategiesToUse = [
    new ArbitrageStrategy(), // Spatial arbitrage between GalaSwap and Binance
    // Disabled other strategies - only arbitrage should run
    // ...(binanceTradingStrategy ? [binanceTradingStrategy] : []),
    // new BasicSwapAccepterStrategy(),
    // new BasicSwapCreatorStrategy(),
  ];

  let reporter: IStatusReporter = new ConsoleStatusReporter();

  if (slackInfoWebhookUri) {
    reporter = new SlackWebhookStatusReporter(slackInfoWebhookUri, slackAlertWebhookUri!);
  } else if (discordInfoWebhookUri) {
    reporter = new DiscordStatusReporter(discordInfoWebhookUri, discordAlertWebhookUri!);
  }

  /* End of dependencies */

  // Liftoff...

  console.log('Started');

  try {
    await mainLoop(
      loopWaitMs,
      selfWalletAddress,
      logger,
      galaSwapApi,
      reporter,
      createdSwapStore,
      acceptedSwapStore,
      priceStore,
      strategiesToUse,
      delayBeforeExecuteMs,
      {
        ignoreSwapsCreatedBefore,
        binanceApi,
        binanceTrading,
        galaChainRouter,
        tokenConfig: defaultTokenConfig,
      },
    );
  } catch (err) {
    logger.error(err);
    try {
      await reporter.sendAlert('Entering eternal sleep due to error - reboot me');
    } catch (err) {
      logger.error(err);
    }

    while (true) {
      await sleep(10_000);
    }
  }
}

const logger = pino();

main(logger)
  .then(() => {
    logger.info('Main loop exited');
  })
  .catch((err) => {
    logger.error(err);
    process.exit(1);
  });
