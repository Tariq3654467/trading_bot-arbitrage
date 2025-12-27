import BigNumber from 'bignumber.js';
import util from 'util';
import { MongoAcceptedSwapStore } from './dependencies/accepted_swap_store.js';
import { IBinanceApi } from './dependencies/binance/binance_api.js';
import { BinanceTrading } from './dependencies/binance/binance_trading.js';
import { IBinanceTokenMappingConfig } from './dependencies/binance/token_mapping.js';
import { MongoCreatedSwapStore } from './dependencies/created_swap_store.js';
import { IGalaDeFiApi } from './dependencies/galadefi/galadefi_api.js';
import { IGalaSwapApi, IGalaSwapToken, IRawSwap, ITokenBalance } from './dependencies/galaswap/types.js';
import { GalaChainRouter } from './dependencies/onchain/galachain_router.js';
import { aggregatePrices, IEnhancedTokenPrice } from './dependencies/price_aggregator.js';
import { MongoPriceStore } from './dependencies/price_store.js';
import { IStatusReporter } from './dependencies/status_reporters.js';
import { ISwapStrategy, ISwapToAccept } from './strategies/swap_strategy.js';
import { defaultTokenConfig, ITokenConfig } from './token_config.js';
import { stringifyTokenClass } from './types/type_helpers.js';
import { ILogger } from './types/types.js';
import { checkMarketPriceWithinRanges } from './utils/check_market_prices_in_range.js';
import { mirrorSwapToBinance, rebalanceWithBinance } from './utils/mirror_to_binance.js';

const sleep = util.promisify(setTimeout);

async function handleSwapAcceptResult(
  acceptedSwapStore: MongoAcceptedSwapStore,
  reporter: IStatusReporter,
  swapToAccept: Readonly<ISwapToAccept>,
  swapAcceptResult: Awaited<ReturnType<IGalaSwapApi['acceptSwap']>>,
) {
  if (swapAcceptResult.status === 'accepted') {
    await acceptedSwapStore.addAcceptedSwap(
      swapToAccept,
      stringifyTokenClass(swapToAccept.wanted[0].tokenInstance),
      stringifyTokenClass(swapToAccept.offered[0].tokenInstance),
      BigNumber(swapToAccept.wanted[0].quantity).multipliedBy(swapToAccept.usesToAccept).toNumber(),
      BigNumber(swapToAccept.offered[0].quantity)
        .multipliedBy(swapToAccept.usesToAccept)
        .toNumber(),
      swapToAccept.goodnessRating,
    );
  } else if (swapAcceptResult.status === 'already_accepted') {
    await reporter.sendAlert(
      `I wasn't fast enough and someone else accepted swap ${swapToAccept.swapRequestId} before I could.`,
    );
  }
}

export async function mainLoopTick(
  ownWalletAddress: string,
  logger: ILogger,
  galaSwapApi: IGalaSwapApi,
  reporter: IStatusReporter,
  createdSwapStore: MongoCreatedSwapStore,
  acceptedSwapStore: MongoAcceptedSwapStore,
  priceStore: MongoPriceStore,
  strategies: ISwapStrategy[],
  executionDelay: number,
  options: {
    ignoreSwapsCreatedBefore?: Date;
    now?: Date;
    tokenConfig?: ITokenConfig;
    binanceApi?: IBinanceApi | null;
    binanceMappingConfig?: IBinanceTokenMappingConfig;
    binanceTrading?: BinanceTrading | null;
    galaDeFiApi?: IGalaDeFiApi | null;
    galaChainRouter?: GalaChainRouter | null;
  } = {},
) {
  try {
    // Get all swaps for oneself. This may return swaps that have already been fully used
    // or expired, so the options.ignoreSwapsCreatedBefore option is an optimization to
    // let us ignore those. If we know that we do not have any swaps that were created
    // before a certain date and which are still active, we can set this option to that
    // date to avoid processing those swaps.
    // Try chaincode first, fall back to REST API
    let ownSwaps: readonly Readonly<IRawSwap>[];
    try {
      if (options.galaChainRouter) {
        // Note: getSwapsByWalletAddress via chaincode - may need to implement this method
        // For now, fall through to REST API
        ownSwaps = (await galaSwapApi.getSwapsByWalletAddress(ownWalletAddress)).filter(
          (swap) =>
            !options.ignoreSwapsCreatedBefore ||
            new Date(swap.created) >= options.ignoreSwapsCreatedBefore,
        );
      } else {
        ownSwaps = (await galaSwapApi.getSwapsByWalletAddress(ownWalletAddress)).filter(
          (swap) =>
            !options.ignoreSwapsCreatedBefore ||
            new Date(swap.created) >= options.ignoreSwapsCreatedBefore,
        );
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get swaps, using empty array');
      ownSwaps = [];
    }

    // Try chaincode first for balances, fall back to REST API
    let ownBalances: readonly Readonly<ITokenBalance>[];
    try {
      if (options.galaChainRouter) {
        ownBalances = await options.galaChainRouter.getBalances(ownWalletAddress);
        if (ownBalances.length === 0) {
          // Fall back to REST API if chaincode returns empty
          logger.info('Chaincode returned empty balances, trying REST API');
          ownBalances = await galaSwapApi.getRawBalances(ownWalletAddress);
        }
      } else {
        ownBalances = await galaSwapApi.getRawBalances(ownWalletAddress);
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get balances via chaincode, trying REST API');
      try {
        ownBalances = await galaSwapApi.getRawBalances(ownWalletAddress);
      } catch (restError) {
        logger.error({ error: restError }, 'Failed to get balances from both chaincode and REST API');
        ownBalances = [];
      }
    }

    // Try chaincode first for tokens, fall back to REST API
    let trendingTokenValues: readonly Readonly<IGalaSwapToken>[];
    try {
      if (options.galaChainRouter) {
        trendingTokenValues = await options.galaChainRouter.getTokens();
        if (trendingTokenValues.length === 0) {
          // Fall back to REST API if chaincode returns empty
          logger.info('Chaincode returned empty tokens, trying REST API');
          trendingTokenValues = (await galaSwapApi.getTokens()).tokens;
        }
      } else {
        trendingTokenValues = (await galaSwapApi.getTokens()).tokens;
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get tokens via chaincode, trying REST API');
      try {
        trendingTokenValues = (await galaSwapApi.getTokens()).tokens;
      } catch (restError) {
        logger.error({ error: restError }, 'Failed to get tokens from both chaincode and REST API');
        trendingTokenValues = [];
      }
    }

    const projectTokensConfig =
      options.tokenConfig?.projectTokens || defaultTokenConfig.projectTokens;
    // Get project tokens - try chaincode first, fall back to REST API
    const projectTokenValues = (
      await Promise.all(
        projectTokensConfig.map(async (token) => {
          try {
            if (options.galaChainRouter) {
              const chaincodeTokens = await options.galaChainRouter.getTokens(token.symbol);
              if (chaincodeTokens.length > 0) {
                return chaincodeTokens;
              }
            }
            // Fall back to REST API
            return (await galaSwapApi.getTokens(token.symbol)).tokens;
          } catch (error) {
            logger.warn({ error, token: token.symbol }, 'Failed to get project token, trying REST API');
            try {
              return (await galaSwapApi.getTokens(token.symbol)).tokens;
            } catch (restError) {
              logger.error({ error: restError, token: token.symbol }, 'Failed to get project token from both sources');
              return [];
            }
          }
        }),
      )
    ).flat();

    const rawTokenValues = trendingTokenValues.concat(projectTokenValues);

    // Aggregate prices from GalaSwap and Binance
    const binanceMappingConfig: IBinanceTokenMappingConfig | undefined = options.tokenConfig?.binance
      ? {
          enabled: options.tokenConfig.binance.enabled,
          mappings: options.tokenConfig.binance.mappings.map((m) => ({
            galaToken: m.galaToken,
            binanceSymbol: m.binanceSymbol,
            quoteCurrency: m.quoteCurrency ?? undefined,
          })),
          defaultQuoteCurrency: options.tokenConfig.binance.defaultQuoteCurrency,
        }
      : undefined;

    const allTokenValues = (await aggregatePrices(
      rawTokenValues,
      options.binanceApi ?? null,
      binanceMappingConfig ?? { enabled: false, mappings: [] },
      logger,
      options.tokenConfig,
    )) as IEnhancedTokenPrice[];

    checkMarketPriceWithinRanges(allTokenValues, options.tokenConfig?.priceLimits, logger);

    await priceStore.addPrices(
      allTokenValues
        .filter((t) => typeof t.currentPrices.usd === 'number')
        .map((tokenValue) => ({
          tokenClass: {
            collection: tokenValue.collection,
            category: tokenValue.category,
            type: tokenValue.type,
            additionalKey: tokenValue.additionalKey,
          },
          price: tokenValue.currentPrices.usd!,
        })),
      options.now ?? new Date(),
    );

    // Diff the current swaps with the ones we have stored in the database
    // and report any whose usesSpent has changed.
    await Promise.all(
      ownSwaps.map(async (swap) => {
        const swapStateBefore = await createdSwapStore.updateSwap(swap);
        if (!swapStateBefore) {
          return;
        }

        const didGetUsed = swapStateBefore.usesSpent !== swap.usesSpent;

        if (didGetUsed) {
          const usesSpentThisUse = BigNumber(swap.usesSpent)
            .minus(swapStateBefore.usesSpent)
            .toString();
          const amountGivenThisUse = BigNumber(swap.offered[0].quantity)
            .multipliedBy(usesSpentThisUse)
            .toNumber();
          const amountReceivedThisUse = BigNumber(swap.wanted[0].quantity)
            .multipliedBy(usesSpentThisUse)
            .toNumber();

          await createdSwapStore.addSwapUse(
            {
              ...swap,
            },
            usesSpentThisUse,
            amountGivenThisUse,
            amountReceivedThisUse,
          );

          await reporter.sendCreatedSwapAcceptedMessage(allTokenValues, swapStateBefore, swap);
        }
      }),
    );

    // Execute each strategy and act on the results it returns (if any).
    // Add binanceMappingConfig to options for strategies that need it
    const strategyOptions = {
      ...options,
      binanceMappingConfig,
    };
    
    for (const strategy of strategies) {
      const { swapsToAccept, swapsToCreate, swapsToTerminate } = await strategy.doTick(
        logger,
        reporter,
        ownWalletAddress,
        galaSwapApi,
        createdSwapStore,
        acceptedSwapStore,
        priceStore,
        ownBalances,
        ownSwaps,
        allTokenValues,
        strategyOptions,
      );

      const hasActionToTake =
        swapsToAccept.length > 0 || swapsToCreate.length > 0 || swapsToTerminate.length > 0;

      for (const swapToTerminate of swapsToTerminate) {
        await reporter.reportTerminatingSwap(allTokenValues, swapToTerminate);
        await galaSwapApi.terminateSwap(swapToTerminate.swapRequestId);
      }

      for (const swapToAccept of swapsToAccept) {
        const reportPromise = reporter.reportAcceptingSwap(allTokenValues, swapToAccept);
        if (executionDelay) {
          await reportPromise;
          await sleep(executionDelay);
        }

        // Use GalaChain router for direct chaincode swaps (official Gala swap) if available
        // Otherwise fall back to REST API (legacy)
        if (options.galaChainRouter) {
          try {
            const swapResult = await options.galaChainRouter.acceptSwap(
              swapToAccept.swapRequestId,
              swapToAccept.usesToAccept,
            );
            logger.info(
              {
                transactionId: swapResult.transactionId,
                swapRequestId: swapToAccept.swapRequestId,
                contractName: options.galaChainRouter.getContractName(),
              },
              'Swap accepted and executed on-chain via GalaChain chaincode contract (official Gala swap)',
            );
            // Mark as accepted in store
            await acceptedSwapStore.addAcceptedSwap(
              swapToAccept,
              stringifyTokenClass(swapToAccept.wanted[0].tokenInstance),
              stringifyTokenClass(swapToAccept.offered[0].tokenInstance),
              BigNumber(swapToAccept.wanted[0].quantity).multipliedBy(swapToAccept.usesToAccept).toNumber(),
              BigNumber(swapToAccept.offered[0].quantity)
                .multipliedBy(swapToAccept.usesToAccept)
                .toNumber(),
              swapToAccept.goodnessRating,
            );
            
            // Mirror swap acceptance to Binance if enabled
            if (options.binanceTrading && options.binanceApi && options.binanceMappingConfig && options.tokenConfig?.binance?.trading?.mirrorGalaSwapTrades) {
              const swapToMirror = {
                offered: swapToAccept.offered,
                wanted: swapToAccept.wanted,
                uses: swapToAccept.usesToAccept,
              };
              await mirrorSwapToBinance(
                swapToMirror,
                options.binanceTrading,
                options.binanceApi,
                options.binanceMappingConfig,
                logger,
                options.tokenConfig.binance.trading.mirrorGalaSwapTrades,
              );
            }
          } catch (error) {
            logger.error(
              { error, swapToAccept },
              'Failed to execute on-chain swap via chaincode, falling back to REST API',
            );
            // Fallback to REST API if chaincode swap fails
            const [acceptResult] = await Promise.all([
              galaSwapApi.acceptSwap(swapToAccept.swapRequestId, swapToAccept.usesToAccept),
              reportPromise,
            ]);
            await handleSwapAcceptResult(acceptedSwapStore, reporter, swapToAccept, acceptResult);
            
            // Mirror swap acceptance to Binance if enabled
            if (options.binanceTrading && options.binanceApi && options.binanceMappingConfig && options.tokenConfig?.binance?.trading?.mirrorGalaSwapTrades) {
              const swapToMirror = {
                offered: swapToAccept.offered,
                wanted: swapToAccept.wanted,
                uses: swapToAccept.usesToAccept,
              };
              await mirrorSwapToBinance(
                swapToMirror,
                options.binanceTrading,
                options.binanceApi,
                options.binanceMappingConfig,
                logger,
                options.tokenConfig.binance.trading.mirrorGalaSwapTrades,
              );
            }
          }
        } else {
          // Use REST API (legacy) if GalaChain router is not available
          logger.warn(
            'GalaChain router not available, using REST API (legacy). Configure GALA_RPC_URL to use official Gala chaincode swaps.',
          );
          const [acceptResult] = await Promise.all([
            galaSwapApi.acceptSwap(swapToAccept.swapRequestId, swapToAccept.usesToAccept),
            reportPromise,
          ]);
          await handleSwapAcceptResult(acceptedSwapStore, reporter, swapToAccept, acceptResult);
          
          // Mirror swap acceptance to Binance if enabled
          if (options.binanceTrading && options.binanceApi && options.binanceMappingConfig && options.tokenConfig?.binance?.trading?.mirrorGalaSwapTrades) {
            const swapToMirror = {
              offered: swapToAccept.offered,
              wanted: swapToAccept.wanted,
              uses: swapToAccept.usesToAccept,
            };
            await mirrorSwapToBinance(
              swapToMirror,
              options.binanceTrading,
              options.binanceApi,
              options.binanceMappingConfig,
              logger,
              options.tokenConfig.binance.trading.mirrorGalaSwapTrades,
            );
          }
        }
      }

      for (const swapToCreate of swapsToCreate) {
        await reporter.reportCreatingSwap(allTokenValues, swapToCreate);
        await sleep(executionDelay);

        // IMPORTANT: Only use official Gala gSwap SDK (via galaChainRouter)
        // DO NOT use the old DEX API (galaDeFiApi) - it's not officially supported by Gala
        // DO NOT fallback to REST API (order book) - only use official gSwap SDK

        if (options.galaChainRouter) {
          try {
            // Use official Gala gSwap SDK for direct swaps (executed immediately on-chain)
            const swapResult = await options.galaChainRouter.requestSwap({
              offered: swapToCreate.offered,
              wanted: swapToCreate.wanted,
            });
            logger.info(
              {
                transactionId: swapResult.transactionId,
                contractName: options.galaChainRouter.getContractName(),
              },
              'Swap created and executed on-chain via GalaChain gSwap SDK (official Gala swap)',
            );
            // Note: On-chain swaps via chaincode are executed immediately, so we still track them
            // Convert to IRawSwap format for storage
            const createdSwap: IRawSwap = {
              ...swapToCreate,
              swapRequestId: swapResult.transactionId,
              created: Date.now(),
              expires: Date.now() + 86400000, // 24 hours default
              uses: '1',
              usesSpent: '0',
              offeredBy: options.galaChainRouter.getWalletAddress(),
            };
            await createdSwapStore.addSwap(createdSwap);
            
            // Mirror swap to Binance if enabled
            if (options.binanceTrading && options.binanceApi && options.binanceMappingConfig && options.tokenConfig?.binance?.trading?.mirrorGalaSwapTrades) {
              await mirrorSwapToBinance(
                swapToCreate,
                options.binanceTrading,
                options.binanceApi,
                options.binanceMappingConfig,
                logger,
                options.tokenConfig.binance.trading.mirrorGalaSwapTrades,
              );
            }
          } catch (error) {
            logger.error(
              { error, swapToCreate },
              'Failed to execute on-chain swap via gSwap SDK. Skipping swap creation (no fallback to REST API).',
            );
            // Do NOT fallback to REST API - only use official gSwap SDK
            // Log error and continue to next swap
          }
        } else {
          // GalaChain router is required - do not use REST API fallback
          logger.error(
            {
              swapToCreate,
            },
            'GalaChain router not available. Cannot create swap without official gSwap SDK. Configure GALA_RPC_URL to enable swap creation.',
          );
          // Do NOT create swap via REST API - skip it
        }
      }

      // Continue processing all strategies even if one took action
      // This allows all pairs to be evaluated and traded in the same tick
    }

    // Rebalancing: Check and rebalance balances between GalaSwap and Binance
    if (
      options.binanceTrading &&
      options.binanceApi &&
      options.binanceMappingConfig &&
      options.tokenConfig?.binance?.trading?.rebalancing?.enabled
    ) {
      await rebalanceWithBinance(
        ownBalances,
        options.binanceTrading,
        options.binanceApi,
        options.binanceMappingConfig,
        logger,
        options.tokenConfig.binance.trading.rebalancing?.targetRatios || {},
        options.tokenConfig.binance.trading.rebalancing?.enabled || false,
        options.tokenConfig.binance.trading.rebalancing?.rebalanceThreshold || 0.1,
      );
    }
  } catch (err) {
    logger.error(err);
    await reporter.sendAlert(`Error in main loop: ${err}`);
    throw err;
  }
}

export async function mainLoop(loopWaitMs: number, ...params: Parameters<typeof mainLoopTick>) {
  while (true) {
    await mainLoopTick(...params);
    await sleep(loopWaitMs);
  }
}
