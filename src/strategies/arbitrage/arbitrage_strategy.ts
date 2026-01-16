import BigNumber from 'bignumber.js';
import { MongoAcceptedSwapStore } from '../../dependencies/accepted_swap_store.js';
import { IBinanceApi } from '../../dependencies/binance/binance_api.js';
import { BinanceTrading } from '../../dependencies/binance/binance_trading.js';
import { IBinanceTokenMappingConfig, getBinanceSymbol } from '../../dependencies/binance/token_mapping.js';
import { MongoCreatedSwapStore } from '../../dependencies/created_swap_store.js';
import {
  IGalaSwapApi,
  IGalaSwapToken,
  IRawSwap,
  ITokenBalance,
} from '../../dependencies/galaswap/types.js';
import { GalaChainRouter } from '../../dependencies/onchain/galachain_router.js';
import { MongoPriceStore } from '../../dependencies/price_store.js';
import { IStatusReporter } from '../../dependencies/status_reporters.js';
import { ITokenConfig } from '../../token_config.js';
import { ILogger, ITokenClassKey } from '../../types/types.js';
import { ISwapStrategy, ISwapToAccept, ISwapToCreate, ISwapToTerminate } from '../swap_strategy.js';

/**
 * Simple Price Gap Arbitrage Strategy
 * 
 * Goal: Compare GALA prices between GalaSwap and Binance, execute when profitable
 * 
 * Simple Strategy:
 * 1. Get GALA price on GalaSwap (from quote)
 * 2. Get GALA price on Binance
 * 3. Calculate price gap
 * 4. If gap > fees + minimum profit → EXECUTE
 * 
 * No complex calculations - just pure price comparison!
 */
export class ArbitrageStrategy implements ISwapStrategy {
  private readonly GALA_AMOUNT: number = 20000; // Maximum amount of GALA to trade
  // ⚠️ TEST MODE: Set to negative to allow small losses for testing
  // Production: Set to 0.5 or higher
  private readonly MIN_PROFIT_GALA: number = 3; // Minimum profit in GALA to execute (increased margin for better profitability)
  // Special threshold for GALA → GWETH (more aggressive to match other bots)
  private readonly MIN_PROFIT_GALA_FOR_GWETH: number = 3; // Allow larger losses for GALA → GWETH (other bots execute these even with fees)
  private readonly MAX_PROFIT_GALA: number = 5000; // Maximum expected profit
  // ⚠️ TEST MODE: Set to true to execute trades even at a loss
  // Production: Set to false
  private readonly ALLOW_LOSS_TRADES: boolean = false; // TESTING: Execute trades even when unprofitable
  // Binance fees: Market orders = 0.1%, Limit maker orders = 0.02% (80% savings!)
  // OPTIMIZED: Using limit orders with maker fees to minimize costs
  private readonly BINANCE_MARKET_FEE_RATE: number = 0.001; // 0.1% for market orders (fallback)
  private readonly BINANCE_MAKER_FEE_RATE: number = 0.0002; // 0.02% for limit maker orders (PRIMARY - 80% savings!)
  private readonly USE_LIMIT_ORDERS: boolean = true; // Use limit orders to get maker fees
  // GalaSwap fees: All pairs use 1% fee tier (10000) as per user requirement
  // Fee tier: 10000 = 1.00% (forced for all pairs)
  private readonly GAS_FEE_GALA: number = 0.2; // Optimized gas estimate (reduced from 0.5 - actual is typically 0.1-0.3 GALA)
  // Minimum GALA amount to attempt trades
  // Production: Set to 3000 or higher
  private readonly MIN_GALA_AMOUNT: number = 3000; // Minimum amount to attempt
  // Try different trade sizes to find profitable opportunities (smaller sizes = less slippage)
  // Production: Minimum 3000 GALA, then scale up
  private readonly TRADE_SIZE_OPTIONS: number[] = [3000, 5000, 10000, 20000, 50000]; // Minimum 3000 GALA
  // Special pairs: GALA → GSOL and GALA → GWBTC both require minimum 1500 GALA
  private readonly MIN_GALA_FOR_GSOL: number = 1500; // Minimum GALA for GALA → GSOL trades
  private readonly MIN_GALA_FOR_GWBTC: number = 1500; // Minimum GALA for GALA → GWBTC trades
  private readonly GALA_TO_GSOL_SIZES: number[] = [1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 10000]; // Trade sizes for GALA → GSOL
  private readonly GALA_TO_GWBTC_SIZES: number[] = [1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 10000];  // Trade sizes for GALA → GWBTC
  
  // Alternative pairs to try if GALA/GWETH has insufficient liquidity
  private readonly ALTERNATIVE_PAIRS = [
    { galaToken: 'GALA', receivingToken: 'GUSDC', binanceSymbol: 'GALAUSDT', description: 'GALA/GUSDC → GALA/USDT' },
    { galaToken: 'GALA', receivingToken: 'GUSDT', binanceSymbol: 'GALAUSDT', description: 'GALA/GUSDT → GALA/USDT' },
  ];
  
  private lastArbitrageCheck: number = 0;
  // ⚠️ TEST MODE: Lower this for faster testing (e.g., 10000 = 10 seconds)
  // Production: Set to 60000 (60 seconds)
  private readonly ARBITRAGE_CHECK_INTERVAL: number = 10000; // TESTING: Check every 10 seconds (faster for testing)
  private gwethFailureCount: number = 0; // Track consecutive GWETH failures
  private readonly GWETH_MAX_FAILURES: number = 3; // Skip GWETH after 3 consecutive failures
  private gwethLastFailureTime: number = 0;
  private readonly GWETH_RETRY_INTERVAL: number = 300000; // Retry GWETH after 5 minutes

  async doTick(
    logger: ILogger,
    reporter: IStatusReporter,
    _selfUserId: string,
    _galaSwapApi: IGalaSwapApi,
    _createdSwapStore: MongoCreatedSwapStore,
    _acceptedSwapStore: MongoAcceptedSwapStore,
    _priceStore: MongoPriceStore,
    ownBalances: readonly Readonly<ITokenBalance>[],
    _ownSwaps: readonly Readonly<IRawSwap>[],
    _tokenValues: readonly Readonly<IGalaSwapToken>[],
    options: {
      now?: Date;
      binanceApi?: IBinanceApi | null;
      binanceTrading?: BinanceTrading | null;
      galaChainRouter?: GalaChainRouter | null;
      tokenConfig?: ITokenConfig;
      binanceMappingConfig?: IBinanceTokenMappingConfig;
    },
  ): Promise<{
    swapsToTerminate: readonly Readonly<ISwapToTerminate>[];
    swapsToAccept: readonly Readonly<ISwapToAccept>[];
    swapsToCreate: readonly Readonly<ISwapToCreate>[];
  }> {
    const now = options.now?.getTime() || Date.now();
    
    // Rate limit arbitrage checks
    if (now - this.lastArbitrageCheck < this.ARBITRAGE_CHECK_INTERVAL) {
      const timeUntilNextCheck = this.ARBITRAGE_CHECK_INTERVAL - (now - this.lastArbitrageCheck);
      logger.debug(
        {
          timeUntilNextCheck: Math.round(timeUntilNextCheck / 1000),
          interval: this.ARBITRAGE_CHECK_INTERVAL / 1000,
        },
        'Arbitrage strategy: rate limited (waiting for next check interval)',
      );
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }
    
    this.lastArbitrageCheck = now;

    // Check if required dependencies are available
    if (!options.binanceApi || !options.binanceTrading || !options.galaChainRouter) {
      logger.warn(
        {
          hasBinanceApi: !!options.binanceApi,
          hasBinanceTrading: !!options.binanceTrading,
          hasGalaChainRouter: !!options.galaChainRouter,
        },
        'Arbitrage strategy: missing required dependencies - skipping check',
      );
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }
    
    // ⚠️ Direct swap mode DISABLED - it was executing both directions (GALA→GWETH then GWETH→GALA)
    // This was reversing trades immediately on the same platform. Use arbitrage checks instead.
    // if (options.galaChainRouter && options.binanceApi && options.binanceTrading) {
    //   try {
    //     await this.executeDirectGalaGwethSwaps(
    //       logger,
    //       options.galaChainRouter,
    //       options.binanceApi,
    //       options.binanceTrading,
    //       ownBalances,
    //     );
    //   } catch (error: any) {
    //     logger.debug(
    //       {
    //         error: error?.message || error?.toString() || error,
    //       },
    //       'Direct GALA ↔ GWETH swap mode failed, continuing with arbitrage checks',
    //     );
    //   }
    // }
    
    logger.info('Arbitrage strategy: starting opportunity check');

    // Get Binance mapping config
    const binanceMappingConfig = options.binanceMappingConfig;
    if (!binanceMappingConfig || !binanceMappingConfig.enabled) {
      logger.warn('Arbitrage strategy: Binance mapping config not available or disabled - skipping check');
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }

    // Find all token balances that have Binance mappings
    const arbitrageableTokens: Array<{
      balance: ITokenBalance;
      binanceSymbol: string;
      quoteCurrency: string;
      tokenKey: ITokenClassKey;
    }> = [];

    for (const balance of ownBalances) {
      const tokenKey: ITokenClassKey = {
        collection: balance.collection,
        category: balance.category,
        type: balance.type,
        additionalKey: balance.additionalKey,
      };

      // Check if this token has a Binance mapping
      const binanceSymbol = getBinanceSymbol(tokenKey, binanceMappingConfig);
      
      if (binanceSymbol) {
        // Find the mapping to get quote currency
        const mapping = binanceMappingConfig.mappings.find(
          (m) =>
            m.galaToken.collection === tokenKey.collection &&
            m.galaToken.category === tokenKey.category &&
            m.galaToken.type === tokenKey.type &&
            m.galaToken.additionalKey === tokenKey.additionalKey,
        );
        
        const quoteCurrency = mapping?.quoteCurrency || binanceMappingConfig.defaultQuoteCurrency || 'USDT';
        const balanceAmount = BigNumber(balance.quantity);
        
        // Only include if balance meets minimum (convert to equivalent GALA value for comparison)
        // For now, use a simple check: if balance is significant enough
        if (balanceAmount.isGreaterThan(0)) {
          arbitrageableTokens.push({
            balance,
            binanceSymbol,
            quoteCurrency,
            tokenKey,
          });
        }
      }
    }

    // ✅ TRADING MODE: All pairs enabled (GALA, GWETH, GWBTC, GSOL, GUSDC, GUSDT, and others)
    // NOTE: All pairs use 1% fee tier (10000) as per user requirement
    // Use all tokens that have Binance mappings
    const filteredArbitrageableTokens = arbitrageableTokens;
    
    if (filteredArbitrageableTokens.length === 0) {
      logger.info(
        {
          totalTokens: arbitrageableTokens.length,
          note: 'No tokens with Binance mappings found - skipping arbitrage checks',
        },
        'Arbitrage strategy: No tokens available for trading',
      );
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }

    logger.info(
      {
        arbitrageableTokens: filteredArbitrageableTokens.map(t => ({
          token: t.balance.collection,
          balance: t.balance.quantity,
          binanceSymbol: t.binanceSymbol,
        })),
        totalTokens: filteredArbitrageableTokens.length,
        note: '✅ TRADING MODE: All pairs enabled (GALA, GWETH, GWBTC, GSOL, GUSDC, GUSDT, and others). All pairs use 1% fee tier.',
      },
      'Arbitrage strategy: found tokens with Binance mappings - checking opportunities',
    );

    try {
      let bestOpportunity: {
        receivingTokenAmount: number;
        galaBuyableOnBinance: number;
        totalFees: number;
        netProfit: number;
        pair: string;
        tradeAmount: number;
        direction?: 'GalaSwap->Binance' | 'Binance->GalaSwap';
        token: string;
      } | null = null;

      // Track all opportunities for summary logging
      const allOpportunities: Array<{
        tradeSize: number;
        netProfit: number;
        pair: string;
        direction: string;
        token: string;
      }> = [];

      // Check arbitrage opportunities for each token that has a Binance mapping
      // ✅ All tokens with Binance mappings are processed (GALA, GWETH, GWBTC, GSOL, GUSDC, GUSDT, and others)
      // All pairs use 1% fee tier (10000) as per user requirement
      for (const tokenInfo of filteredArbitrageableTokens) {
        const tokenBalance = BigNumber(tokenInfo.balance.quantity);
        const tokenName = tokenInfo.balance.collection;
        
        // Calculate valid trade sizes for this token
        // For GALA, use the configured amounts; for others, calculate based on token value
        let maxTradeAmount: number;
        let minTradeAmount: number;
        let tradeSizeOptions: number[];
        
        if (tokenName === 'GALA') {
          maxTradeAmount = this.GALA_AMOUNT;
          minTradeAmount = this.MIN_GALA_AMOUNT;
          // Include special sizes for GALA → GSOL and GALA → GWBTC (minimum 5000)
          // Combine standard sizes with special sizes, removing duplicates
          const allSizes = [...this.TRADE_SIZE_OPTIONS, ...this.GALA_TO_GSOL_SIZES, ...this.GALA_TO_GWBTC_SIZES];
          tradeSizeOptions = [...new Set(allSizes)].sort((a, b) => a - b);
        } else if (tokenName === 'GWETH') {
          // For ETH, use very small amounts to work around liquidity issues
          // Try: 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01 ETH
          maxTradeAmount = Math.min(tokenBalance.toNumber() * 0.5, 0.1);
          minTradeAmount = 0.0001; // Very small minimum
          tradeSizeOptions = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
        } else if (tokenName === 'GWBTC') {
          // For BTC, use very small amounts (BTC is worth ~$40k+, so 0.0001 BTC = ~$4)
          // Try: 0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001 BTC
          maxTradeAmount = Math.min(tokenBalance.toNumber() * 0.5, 0.01);
          minTradeAmount = 0.00001; // Very small minimum
          tradeSizeOptions = [0.00001, 0.00002, 0.00005, 0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005];
        } else if (tokenName === 'GSOL') {
          // For SOL, use small amounts (SOL is worth ~$100+, so 0.01 SOL = ~$1)
          // Try: 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5 SOL
          maxTradeAmount = Math.min(tokenBalance.toNumber() * 0.5, 1);
          minTradeAmount = 0.001; // Very small minimum
          tradeSizeOptions = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];
        } else if (tokenName === 'GUSDC' || tokenName === 'GUSDT') {
          // For stablecoins, use dollar amounts: $10, $25, $50, $100, $250, $500
          maxTradeAmount = Math.min(tokenBalance.toNumber() * 0.5, 1000);
          minTradeAmount = 10;
          tradeSizeOptions = [10, 25, 50, 100, 250, 500, 1000];
        } else {
          // For other tokens, try to estimate based on balance
          // Use 10%, 25%, 50% of balance, but cap at reasonable amounts
          const balanceNum = tokenBalance.toNumber();
          maxTradeAmount = Math.min(balanceNum * 0.5, 1000);
          minTradeAmount = Math.min(balanceNum * 0.1, 100);
          // Generate trade sizes: 10%, 25%, 50% of balance
          tradeSizeOptions = [
            Math.max(minTradeAmount, balanceNum * 0.1),
            Math.max(minTradeAmount, balanceNum * 0.25),
            Math.max(minTradeAmount, balanceNum * 0.5),
          ].filter((size, index, arr) => size > 0 && (index === 0 || size !== arr[index - 1]));
        }
        
        const validSizes = tradeSizeOptions
          .filter(size => size <= tokenBalance.toNumber() && size <= maxTradeAmount && size >= minTradeAmount)
          .sort((a, b) => a - b);
        
        if (validSizes.length === 0) {
          logger.debug(
            {
              token: tokenName,
              balance: tokenBalance.toString(),
              minRequired: minTradeAmount,
              maxAllowed: maxTradeAmount,
            },
            `Arbitrage: Skipping ${tokenName} - insufficient balance for minimum trade size`,
          );
          continue;
        }

        logger.info(
          {
            token: tokenName,
            balance: tokenBalance.toString(),
            validSizes: validSizes,
            binanceSymbol: tokenInfo.binanceSymbol,
            totalSizes: validSizes.length,
          },
          `Arbitrage: Checking opportunities for ${tokenName}`,
        );

        // Check if we should skip GWETH due to recent failures (circuit breaker)
        const now = Date.now();
        const shouldSkipGweth = tokenName === 'GALA' && 
                                this.gwethFailureCount >= this.GWETH_MAX_FAILURES && 
                                (now - this.gwethLastFailureTime) < this.GWETH_RETRY_INTERVAL;
        
        if (shouldSkipGweth) {
          logger.info(
            {
              failureCount: this.gwethFailureCount,
              lastFailureTime: new Date(this.gwethLastFailureTime).toISOString(),
              retryAfter: new Date(this.gwethLastFailureTime + this.GWETH_RETRY_INTERVAL).toISOString(),
              note: 'GWETH pool has insufficient liquidity. Skipping GWETH checks temporarily.',
            },
            'Arbitrage: Skipping GWETH checks (circuit breaker active)',
          );
        }

        // Try each trade size to find the most profitable opportunity for this token
        for (const tradeSize of validSizes) {
          logger.info(
            {
              token: tokenName,
              tradeSize,
              balance: tokenBalance.toString(),
            },
            `Arbitrage: Checking ${tokenName} opportunity with trade size`,
          );

          // Collect all opportunity checks for this token/tradeSize to run in parallel
          type CheckTask = {
            promise: Promise<ReturnType<typeof this.checkArbitrageOpportunity> | null>;
            pair: string;
            description: string;
          };
          
          const checksToRun: CheckTask[] = [];
          
          // For GALA, collect all pairs to check in parallel
          if (tokenName === 'GALA') {
            // Try GALA/GWETH first (primary pair) - but only if circuit breaker is not active
            if (!shouldSkipGweth) {
              checksToRun.push({
                promise: this.checkArbitrageOpportunity(
                  logger,
                  options.binanceApi,
                  options.galaChainRouter,
                  tradeSize,
                  'GALA',
                  'GWETH',
                  'GALAETH',
                  'ETHUSDT',
                ),
                pair: 'GALA/GWETH',
                description: 'GALA → GWETH',
              });
            }

            // GALA → GSOL (minimum 1500 GALA)
            if (tradeSize >= this.MIN_GALA_FOR_GSOL) {
              checksToRun.push({
                promise: this.checkArbitrageOpportunity(
                  logger,
                  options.binanceApi,
                  options.galaChainRouter,
                  tradeSize,
                  'GALA',
                  'GSOL',
                  'GALAUSDT',
                  'SOLUSDT',
                ),
                pair: 'GALA/GSOL',
                description: 'GALA → GSOL',
              });
            }

            // GALA → GWBTC (minimum 1500 GALA)
            if (tradeSize >= this.MIN_GALA_FOR_GWBTC) {
              checksToRun.push({
                promise: this.checkArbitrageOpportunity(
                  logger,
                  options.binanceApi,
                  options.galaChainRouter,
                  tradeSize,
                  'GALA',
                  'GWBTC',
                  'GALAUSDT',
                  'BTCUSDT',
                ),
                pair: 'GALA/GWBTC',
                description: 'GALA → GWBTC',
              });
            }

            // Alternative stablecoin pairs
            for (const pair of this.ALTERNATIVE_PAIRS) {
              checksToRun.push({
                promise: this.checkArbitrageOpportunity(
                  logger,
                  options.binanceApi,
                  options.galaChainRouter,
                  tradeSize,
                  pair.galaToken,
                  pair.receivingToken,
                  pair.binanceSymbol,
                  'USDT',
                ),
                pair: pair.description,
                description: pair.description,
              });
            }
            
            // Run all checks in parallel
            logger.info(
              {
                token: tokenName,
                tradeSize,
                totalChecks: checksToRun.length,
                pairs: checksToRun.map(c => c.pair),
              },
              `Arbitrage: Running ${checksToRun.length} parallel checks for ${tokenName}`,
            );
            
            const results = await Promise.allSettled(checksToRun.map(check => check.promise));
            
            // Process all results to find the best opportunity
            let arbitrageOpportunity: ReturnType<typeof this.checkArbitrageOpportunity> extends Promise<infer T> ? T : null = null;
            let gwethCheckFailed = false;
            
            for (let i = 0; i < results.length; i++) {
              const result = results[i];
              const check = checksToRun[i];
              
              if (result.status === 'fulfilled' && result.value) {
                const opportunity = result.value;
                
                // Handle GWETH circuit breaker
                if (check.pair === 'GALA/GWETH') {
                  if (!opportunity) {
                    gwethCheckFailed = true;
                    this.gwethFailureCount++;
                    this.gwethLastFailureTime = now;
                    if (this.gwethFailureCount >= this.GWETH_MAX_FAILURES) {
                      logger.warn(
                        {
                          failureCount: this.gwethFailureCount,
                          maxFailures: this.GWETH_MAX_FAILURES,
                          retryAfter: new Date(now + this.GWETH_RETRY_INTERVAL).toISOString(),
                          note: 'GWETH pool has insufficient liquidity. Will skip GWETH checks for 5 minutes.',
                        },
                        'GWETH circuit breaker activated - skipping GWETH checks',
                      );
                    } else {
                      logger.info(
                        {
                          failureCount: this.gwethFailureCount,
                          maxFailures: this.GWETH_MAX_FAILURES,
                          tradeSize,
                        },
                        'Arbitrage: GWETH check failed (liquidity issue)',
                      );
                    }
                  } else {
                    if (this.gwethFailureCount > 0) {
                      logger.info(
                        {
                          previousFailures: this.gwethFailureCount,
                          note: 'GWETH pool now has liquidity - resetting failure counter',
                        },
                        'GWETH arbitrage check succeeded (circuit breaker reset)',
                      );
                    }
                    this.gwethFailureCount = 0;
                  }
                }
                
                // Track this opportunity
                if (opportunity) {
                  logger.info(
                    {
                      pair: check.pair,
                      netProfit: opportunity.netProfit.toFixed(4),
                      tradeSize,
                      isProfitable: opportunity.netProfit > 0,
                    },
                    `Arbitrage: Found ${check.description} opportunity`,
                  );
                  
                  // Select the best opportunity (most profitable)
                  if (!arbitrageOpportunity || 
                      (opportunity.netProfit > 0 && (!arbitrageOpportunity.netProfit || arbitrageOpportunity.netProfit <= 0 || opportunity.netProfit > arbitrageOpportunity.netProfit)) ||
                      (opportunity.netProfit <= 0 && arbitrageOpportunity.netProfit <= 0 && opportunity.netProfit > arbitrageOpportunity.netProfit)) {
                    arbitrageOpportunity = opportunity;
                  }
                }
              } else if (result.status === 'rejected') {
                logger.warn(
                  {
                    pair: check.pair,
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                  },
                  `Arbitrage: Check failed for ${check.description}`,
                );
                
                // Handle GWETH circuit breaker for rejected promises
                if (check.pair === 'GALA/GWETH') {
                  gwethCheckFailed = true;
                  this.gwethFailureCount++;
                  this.gwethLastFailureTime = now;
                }
              }
            }
          } else if (tokenName === 'GWETH') {
            // For GWETH, collect all pairs to check in parallel
            checksToRun.push({
              promise: this.checkArbitrageOpportunity(
                logger,
                options.binanceApi,
                options.galaChainRouter,
                tradeSize,
                'GWETH',
                'GALA',
                'GALAUSDT', // Will use GALA → USDT → ETH path on Binance
                'ETHUSDT', // Use ETHUSDT for GWETH price (not USDT)
              ),
              pair: 'GWETH/GALA',
              description: 'GWETH → GALA',
            });
            
            // Fallback: Try GWETH → GUSDC/GUSDT
            const receivingTokens = ['GUSDC', 'GUSDT'];
            for (const receivingToken of receivingTokens) {
              checksToRun.push({
                promise: this.checkArbitrageOpportunity(
                  logger,
                  options.binanceApi,
                  options.galaChainRouter,
                  tradeSize,
                  tokenName,
                  receivingToken,
                  tokenInfo.binanceSymbol,
                  'USDT',
                ),
                pair: `${tokenName}/${receivingToken}`,
                description: `${tokenName} → ${receivingToken}`,
              });
            }
            
            // Run all checks in parallel
            logger.info(
              {
                token: tokenName,
                tradeSize,
                totalChecks: checksToRun.length,
                pairs: checksToRun.map(c => c.pair),
              },
              `Arbitrage: Running ${checksToRun.length} parallel checks for ${tokenName}`,
            );
            
            const results = await Promise.allSettled(checksToRun.map(check => check.promise));
            
            // Process all results to find the best opportunity
            let arbitrageOpportunity: ReturnType<typeof this.checkArbitrageOpportunity> extends Promise<infer T> ? T : null = null;
            
            for (let i = 0; i < results.length; i++) {
              const result = results[i];
              const check = checksToRun[i];
              
              if (result.status === 'fulfilled' && result.value) {
                const opportunity = result.value;
                if (opportunity) {
                  logger.info(
                    {
                      pair: check.pair,
                      netProfit: opportunity.netProfit.toFixed(4),
                      tradeSize,
                      isProfitable: opportunity.netProfit > 0,
                    },
                    `Arbitrage: Found ${check.description} opportunity`,
                  );
                  
                  // Select the best opportunity (most profitable)
                  if (!arbitrageOpportunity || 
                      (opportunity.netProfit > 0 && (!arbitrageOpportunity.netProfit || arbitrageOpportunity.netProfit <= 0 || opportunity.netProfit > arbitrageOpportunity.netProfit)) ||
                      (opportunity.netProfit <= 0 && arbitrageOpportunity.netProfit <= 0 && opportunity.netProfit > arbitrageOpportunity.netProfit)) {
                    arbitrageOpportunity = opportunity;
                  }
                }
              } else if (result.status === 'rejected') {
                logger.warn(
                  {
                    pair: check.pair,
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                  },
                  `Arbitrage: Check failed for ${check.description}`,
                );
              }
            }
          } else if (tokenName === 'GWBTC') {
            // For GWBTC, collect all pairs to check in parallel
            checksToRun.push({
              promise: this.checkArbitrageOpportunity(
                logger,
                options.binanceApi,
                options.galaChainRouter,
                tradeSize,
                'GWBTC',
                'GALA',
                'GALAUSDT', // Will use GALA → USDT → BTC path on Binance
                'BTCUSDT', // Use BTCUSDT to get BTC price for comparison
              ),
              pair: 'GWBTC/GALA',
              description: 'GWBTC → GALA',
            });
            
            // Fallback: Try GWBTC → GUSDC/GUSDT
            const receivingTokens = ['GUSDC', 'GUSDT'];
            for (const receivingToken of receivingTokens) {
              checksToRun.push({
                promise: this.checkArbitrageOpportunity(
                  logger,
                  options.binanceApi,
                  options.galaChainRouter,
                  tradeSize,
                  tokenName,
                  receivingToken,
                  tokenInfo.binanceSymbol,
                  'USDT',
                ),
                pair: `${tokenName}/${receivingToken}`,
                description: `${tokenName} → ${receivingToken}`,
              });
            }
            
            // Run all checks in parallel
            logger.info(
              {
                token: tokenName,
                tradeSize,
                totalChecks: checksToRun.length,
                pairs: checksToRun.map(c => c.pair),
              },
              `Arbitrage: Running ${checksToRun.length} parallel checks for ${tokenName}`,
            );
            
            const results = await Promise.allSettled(checksToRun.map(check => check.promise));
            
            // Process all results to find the best opportunity
            let arbitrageOpportunity: ReturnType<typeof this.checkArbitrageOpportunity> extends Promise<infer T> ? T : null = null;
            
            for (let i = 0; i < results.length; i++) {
              const result = results[i];
              const check = checksToRun[i];
              
              if (result.status === 'fulfilled' && result.value) {
                const opportunity = result.value;
                if (opportunity) {
                  logger.info(
                    {
                      pair: check.pair,
                      netProfit: opportunity.netProfit.toFixed(4),
                      tradeSize,
                      isProfitable: opportunity.netProfit > 0,
                    },
                    `Arbitrage: Found ${check.description} opportunity`,
                  );
                  
                  // Select the best opportunity (most profitable)
                  if (!arbitrageOpportunity || 
                      (opportunity.netProfit > 0 && (!arbitrageOpportunity.netProfit || arbitrageOpportunity.netProfit <= 0 || opportunity.netProfit > arbitrageOpportunity.netProfit)) ||
                      (opportunity.netProfit <= 0 && arbitrageOpportunity.netProfit <= 0 && opportunity.netProfit > arbitrageOpportunity.netProfit)) {
                    arbitrageOpportunity = opportunity;
                  }
                }
              } else if (result.status === 'rejected') {
                logger.warn(
                  {
                    pair: check.pair,
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                  },
                  `Arbitrage: Check failed for ${check.description}`,
                );
              }
            }
          } else if (tokenName === 'GSOL') {
            // For GSOL, try direct GSOL → GALA swap first
            logger.info(
              {
                token: tokenName,
                tradeSize,
                pair: 'GSOL/GALA',
              },
              `Arbitrage: Checking GSOL → GALA direct swap opportunity`,
            );
            
            // Check arbitrage: Sell GSOL on GalaSwap for GALA, then mirror on Binance
            arbitrageOpportunity = await this.checkArbitrageOpportunity(
              logger,
              options.binanceApi,
              options.galaChainRouter,
              tradeSize,
              'GSOL',
              'GALA',
              'GALAUSDT', // Will use GALA → USDT → SOL path on Binance
              'SOLUSDT', // Use SOLUSDT to get SOL price for comparison
            );
            
            if (arbitrageOpportunity) {
              logger.info(
                {
                  token: tokenName,
                  pair: 'GSOL/GALA',
                  netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                  tradeSize,
                  isProfitable: arbitrageOpportunity.netProfit > 0,
                },
                `Arbitrage: Found GSOL → GALA opportunity`,
              );
            } else {
              // Fallback: Try GSOL → GUSDC if direct swap doesn't work
              // Note: GSOL/GUSDT pool doesn't exist, so only try GUSDC
              logger.info(
                {
                  token: tokenName,
                  receivingToken: 'GUSDC',
                  tradeSize,
                  binanceSymbol: tokenInfo.binanceSymbol,
                },
                `Arbitrage: Checking ${tokenName}/GUSDC -> ${tokenInfo.binanceSymbol}`,
              );
              
              arbitrageOpportunity = await this.checkArbitrageOpportunity(
                logger,
                options.binanceApi,
                options.galaChainRouter,
                tradeSize,
                tokenName,
                'GUSDC',
                tokenInfo.binanceSymbol,
                'SOLUSDT', // Use SOLUSDT to get SOL price for GSOL → GUSDC conversion
              );
              
              if (arbitrageOpportunity) {
                logger.info(
                  {
                    token: tokenName,
                    pair: `${tokenName}/GUSDC -> ${tokenInfo.binanceSymbol}`,
                    netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                    tradeSize,
                    isProfitable: arbitrageOpportunity.netProfit > 0,
                  },
                  `Arbitrage: Found opportunity for ${tokenName}`,
                );
              }
            }
          } else if (tokenName === 'GSOL') {
            // For GSOL, try direct GSOL → GALA swap first
            logger.info(
              {
                token: tokenName,
                tradeSize,
                pair: 'GSOL/GALA',
              },
              `Arbitrage: Checking GSOL → GALA direct swap opportunity`,
            );
            
            // Check arbitrage: Sell GSOL on GalaSwap for GALA, then mirror on Binance
            arbitrageOpportunity = await this.checkArbitrageOpportunity(
              logger,
              options.binanceApi,
              options.galaChainRouter,
              tradeSize,
              'GSOL',
              'GALA',
              'GALAUSDT', // Will use GALA → USDT → SOL path on Binance
              'SOLUSDT', // Use SOLUSDT to get SOL price for comparison
            );
            
            if (arbitrageOpportunity) {
              logger.info(
                {
                  token: tokenName,
                  pair: 'GSOL/GALA',
                  netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                  tradeSize,
                  isProfitable: arbitrageOpportunity.netProfit > 0,
                },
                `Arbitrage: Found GSOL → GALA opportunity`,
              );
            } else {
              // Fallback: Try GSOL → GUSDC if direct swap doesn't work
              // Note: GSOL/GUSDT pool doesn't exist, so only try GUSDC
              logger.info(
                {
                  token: tokenName,
                  receivingToken: 'GUSDC',
                  tradeSize,
                  binanceSymbol: tokenInfo.binanceSymbol,
                },
                `Arbitrage: Checking ${tokenName}/GUSDC -> ${tokenInfo.binanceSymbol}`,
              );
              
              arbitrageOpportunity = await this.checkArbitrageOpportunity(
                logger,
                options.binanceApi,
                options.galaChainRouter,
                tradeSize,
                tokenName,
                'GUSDC',
                tokenInfo.binanceSymbol,
                'SOLUSDT', // Use SOLUSDT to get SOL price for GSOL → GUSDC conversion
              );
              
              if (arbitrageOpportunity) {
                logger.info(
                  {
                    token: tokenName,
                    pair: `${tokenName}/GUSDC -> ${tokenInfo.binanceSymbol}`,
                    netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                    tradeSize,
                    isProfitable: arbitrageOpportunity.netProfit > 0,
                  },
                  `Arbitrage: Found opportunity for ${tokenName}`,
                );
              }
            }
          } else if (tokenName === 'GUSDC' || tokenName === 'GUSDT') {
            // For stablecoins (GUSDC/GUSDT), try GWETH first, then other stablecoin
            // Strategy: Sell stablecoin on GalaSwap for GWETH, then buy ETH on Binance and convert back
            if (!shouldSkipGweth) {
              logger.info(
                {
                  token: tokenName,
                  tradeSize,
                  pair: `${tokenName}/GWETH`,
                },
                `Arbitrage: Checking ${tokenName} → GWETH opportunity`,
              );
              
              arbitrageOpportunity = await this.checkArbitrageOpportunity(
                logger,
                options.binanceApi,
                options.galaChainRouter,
                tradeSize,
                tokenName,
                'GWETH',
                'ETHUSDT',
                'ETHUSDT',
              );
              
              if (arbitrageOpportunity) {
                logger.info(
                  {
                    token: tokenName,
                    pair: `${tokenName}/GWETH`,
                    netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                    tradeSize,
                    isProfitable: arbitrageOpportunity.netProfit > 0,
                  },
                  `Arbitrage: Found ${tokenName} → GWETH opportunity`,
                );
              }
            }
            
            // If GWETH failed or skipped, try other stablecoin
            if (!arbitrageOpportunity) {
              const otherStablecoin = tokenName === 'GUSDC' ? 'GUSDT' : 'GUSDC';
              logger.info(
                {
                  token: tokenName,
                  receivingToken: otherStablecoin,
                  tradeSize,
                  binanceSymbol: tokenInfo.binanceSymbol,
                },
                `Arbitrage: Checking ${tokenName}/${otherStablecoin} -> ${tokenInfo.binanceSymbol}`,
              );
              
              arbitrageOpportunity = await this.checkArbitrageOpportunity(
                logger,
                options.binanceApi,
                options.galaChainRouter,
                tradeSize,
                tokenName,
                otherStablecoin,
                tokenInfo.binanceSymbol,
                'USDT',
              );
              
              if (arbitrageOpportunity) {
                logger.info(
                  {
                    token: tokenName,
                    pair: `${tokenName}/${otherStablecoin} -> ${tokenInfo.binanceSymbol}`,
                    netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                    tradeSize,
                    isProfitable: arbitrageOpportunity.netProfit > 0,
                  },
                  `Arbitrage: Found opportunity for ${tokenName}`,
                );
              }
            }
          } else {
            // For all other tokens, try to sell for stablecoin and buy back on Binance
            // Strategy: Sell token on GalaSwap for GUSDC/GUSDT, then buy token on Binance with that USDT value
            const receivingTokens = ['GUSDC', 'GUSDT'];
            
            for (const receivingToken of receivingTokens) {
              logger.info(
                {
                  token: tokenName,
                  receivingToken,
                  tradeSize,
                  binanceSymbol: tokenInfo.binanceSymbol,
                },
                `Arbitrage: Checking ${tokenName}/${receivingToken} -> ${tokenInfo.binanceSymbol}`,
              );
              
              // Check arbitrage: Sell token on GalaSwap for stablecoin, buy token on Binance
              arbitrageOpportunity = await this.checkArbitrageOpportunity(
                logger,
                options.binanceApi,
                options.galaChainRouter,
                tradeSize,
                tokenName,
                receivingToken,
                tokenInfo.binanceSymbol,
                'USDT',
              );
              
              if (arbitrageOpportunity) {
                logger.info(
                  {
                    token: tokenName,
                    pair: `${tokenName}/${receivingToken} -> ${tokenInfo.binanceSymbol}`,
                    netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                    tradeSize,
                    isProfitable: arbitrageOpportunity.netProfit > 0,
                  },
                  `Arbitrage: Found opportunity for ${tokenName}`,
                );
                // Continue checking other pairs for this trade size to find the best opportunity
              }
            }
          }

          // Track all opportunities (even unprofitable ones) for summary
          if (arbitrageOpportunity) {
            allOpportunities.push({
              tradeSize,
              netProfit: arbitrageOpportunity.netProfit,
              pair: arbitrageOpportunity.pair,
              direction: 'GalaSwap->Binance',
              token: tokenName,
            });

            // If we found an opportunity (profitable or loss if allowed), compare it with the best one so far
            const isProfitable = arbitrageOpportunity.netProfit > 0;
            const isGalaToGweth = arbitrageOpportunity.pair === 'GALA/GWETH';
            const minProfitRequired = isGalaToGweth ? this.MIN_PROFIT_GALA_FOR_GWETH : this.MIN_PROFIT_GALA;
            // Allow loss trades if: ALLOW_LOSS_TRADES is true, OR it's GALA/GWETH and meets the special threshold
            const isLossButAllowed = (this.ALLOW_LOSS_TRADES || isGalaToGweth) && 
                                     arbitrageOpportunity.netProfit <= 0 && 
                                     arbitrageOpportunity.netProfit >= minProfitRequired;
            // Allow ANY profitable trade (other bots execute profitable trades regardless of threshold)
            // For loss trades, only allow if they meet the special threshold
            const canExecute = isProfitable || isLossButAllowed;
            
            if (canExecute) {
              // For profitable trades, pick the most profitable
              // For loss trades, pick the one with smallest loss (least negative)
              const isBetter = !bestOpportunity || 
                (isProfitable && (!bestOpportunity.netProfit || bestOpportunity.netProfit <= 0 || arbitrageOpportunity.netProfit > bestOpportunity.netProfit)) ||
                (isLossButAllowed && bestOpportunity.netProfit <= 0 && arbitrageOpportunity.netProfit > bestOpportunity.netProfit);
              
              if (isBetter) {
                bestOpportunity = {
                  ...arbitrageOpportunity,
                  tradeAmount: tradeSize,
                  direction: 'GalaSwap->Binance',
                  token: tokenName,
                };
                if (isProfitable) {
                  logger.info(
                    {
                      token: tokenName,
                      tradeSize,
                      netProfit: arbitrageOpportunity.netProfit,
                      pair: arbitrageOpportunity.pair,
                      direction: 'GalaSwap->Binance',
                    },
                    `Arbitrage: Found profitable opportunity for ${tokenName}`,
                  );
                } else {
                  logger.warn(
                    {
                      token: tokenName,
                      tradeSize,
                      netProfit: arbitrageOpportunity.netProfit,
                      pair: arbitrageOpportunity.pair,
                      direction: 'GalaSwap->Binance',
                      note: isGalaToGweth 
                        ? `Loss trade selected (GALA/GWETH allows losses up to ${this.MIN_PROFIT_GALA_FOR_GWETH} GALA)`
                        : 'Loss trade selected (ALLOW_LOSS_TRADES enabled)',
                    },
                    `⚠️ Arbitrage: Found loss opportunity for ${tokenName} (will execute)`,
                  );
                }
              }
            }
          }
        }

        // Check reverse direction: Binance -> GalaSwap (for tokens that have Binance equivalents)
        // This requires USDT balance on Binance
        if (tokenName !== 'GUSDC' && tokenName !== 'GUSDT') {
          try {
            const binanceBalances = await options.binanceApi.getBalances();
            const usdtBalance = binanceBalances.get('USDT');
            const availableUsdt = usdtBalance ? parseFloat(usdtBalance.free) : 0;
              
            if (availableUsdt >= 10) { // Need at least $10 USDT to try reverse arbitrage
              logger.info(
                {
                  token: tokenName,
                  availableUsdt: availableUsdt.toFixed(2),
                },
                `Arbitrage: Checking reverse direction for ${tokenName} (Binance->GalaSwap)`,
              );

              // Try reverse direction for each trade size
              for (const tradeSize of validSizes) {
                // Get token price on Binance to calculate USDT needed
                const tokenPriceResponse = await options.binanceApi.getPrice(tokenInfo.binanceSymbol);
                if (!tokenPriceResponse) continue;
                
                const tokenPriceUsdt = Number(tokenPriceResponse.price);
                const usdtNeeded = tradeSize * tokenPriceUsdt;
                
                if (usdtNeeded > availableUsdt) continue; // Skip if not enough USDT

                // Check reverse arbitrage: Buy token on Binance, sell on GalaSwap
                // For now, only implement reverse for GALA (can be extended later)
                if (tokenName === 'GALA') {
                  const reverseOpportunity = await this.checkReverseArbitrageOpportunity(
                    logger,
                    options.binanceApi,
                    options.galaChainRouter,
                    tradeSize,
                    usdtNeeded,
                  );

                  if (reverseOpportunity) {
                    allOpportunities.push({
                      tradeSize,
                      netProfit: reverseOpportunity.netProfit,
                      pair: reverseOpportunity.pair,
                      direction: 'Binance->GalaSwap',
                      token: tokenName,
                    });

                    const isProfitable = reverseOpportunity.netProfit > 0;
                    const isLossButAllowed = this.ALLOW_LOSS_TRADES && reverseOpportunity.netProfit <= 0;
                    // Allow ANY profitable trade (other bots execute profitable trades regardless of threshold)
                    const canExecute = isProfitable || isLossButAllowed;
                    
                    if (canExecute) {
                      const isBetter = !bestOpportunity || 
                        (isProfitable && (!bestOpportunity.netProfit || bestOpportunity.netProfit <= 0 || reverseOpportunity.netProfit > bestOpportunity.netProfit)) ||
                        (isLossButAllowed && bestOpportunity.netProfit <= 0 && reverseOpportunity.netProfit > bestOpportunity.netProfit);
                      
                      if (isBetter) {
                        bestOpportunity = {
                          ...reverseOpportunity,
                          tradeAmount: tradeSize,
                          direction: 'Binance->GalaSwap',
                          token: tokenName,
                        };
                        if (isProfitable) {
                          logger.info(
                            {
                              token: tokenName,
                              tradeSize,
                              netProfit: reverseOpportunity.netProfit,
                              pair: reverseOpportunity.pair,
                              direction: 'Binance->GalaSwap',
                            },
                            `Arbitrage: Found profitable reverse opportunity for ${tokenName}`,
                          );
                        } else {
                          logger.warn(
                            {
                              token: tokenName,
                              tradeSize,
                              netProfit: reverseOpportunity.netProfit,
                              pair: reverseOpportunity.pair,
                              direction: 'Binance->GalaSwap',
                              note: 'Loss trade selected (ALLOW_LOSS_TRADES enabled)',
                            },
                            `⚠️ Arbitrage: Found loss reverse opportunity for ${tokenName} (will execute)`,
                          );
                        }
                      }
                    }
                  }
                }
              }
            } else {
              logger.debug(
                {
                  token: tokenName,
                  availableUsdt: availableUsdt.toFixed(2),
                  minRequired: 10,
                },
                `Arbitrage: Skipping reverse direction for ${tokenName} (insufficient USDT on Binance)`,
              );
            }
          } catch (error) {
            logger.warn(
              {
                token: tokenName,
                error: error instanceof Error ? error.message : String(error),
              },
              `Failed to check reverse arbitrage direction for ${tokenName} (Binance->GalaSwap)`,
            );
          }
        }
      } // End of loop through arbitrageableTokens

      const arbitrageOpportunity = bestOpportunity;

      // Execute if we have an opportunity and either:
      // 1. It's profitable (ANY profit > 0, like other bots), OR
      // 2. ALLOW_LOSS_TRADES is true (execute even at loss), OR
      // 3. For GALA → GWETH: Use more aggressive threshold (allow small losses like other bots)
      const isGalaToGweth = arbitrageOpportunity && arbitrageOpportunity.pair === 'GALA/GWETH';
      const minProfitRequired = isGalaToGweth ? this.MIN_PROFIT_GALA_FOR_GWETH : this.MIN_PROFIT_GALA;
      // Allow ANY profitable trade (other bots execute profitable trades regardless of threshold)
      const isProfitable = arbitrageOpportunity && arbitrageOpportunity.netProfit > 0;
      // For loss trades, only allow if they meet the special threshold
      const shouldExecuteLoss = (this.ALLOW_LOSS_TRADES || isGalaToGweth) && arbitrageOpportunity && arbitrageOpportunity.netProfit <= 0 && arbitrageOpportunity.netProfit >= minProfitRequired;
      
      if (isProfitable || shouldExecuteLoss) {
        const isLoss = arbitrageOpportunity!.netProfit <= 0;
        
        if (isLoss) {
          logger.warn(
            {
              netProfit: arbitrageOpportunity!.netProfit.toFixed(4),
              galaAmount: arbitrageOpportunity!.tradeAmount,
              receivingTokenAmount: arbitrageOpportunity!.receivingTokenAmount,
              galaBuyableOnBinance: arbitrageOpportunity!.galaBuyableOnBinance,
              fees: arbitrageOpportunity!.totalFees,
              pair: arbitrageOpportunity!.pair,
              warning: '⚠️ EXECUTING TRADE AT A LOSS (ALLOW_LOSS_TRADES enabled)',
            },
            '⚠️ Arbitrage opportunity found but will result in LOSS - executing anyway',
          );

          await reporter.sendAlert(
            `⚠️ Arbitrage Trade (LOSS): ${arbitrageOpportunity!.netProfit.toFixed(2)} GALA loss (${arbitrageOpportunity!.tradeAmount} GALA trade)`,
          );
        } else {
          logger.info(
            {
              netProfit: arbitrageOpportunity!.netProfit,
              galaAmount: arbitrageOpportunity!.tradeAmount,
              receivingTokenAmount: arbitrageOpportunity!.receivingTokenAmount,
              galaBuyableOnBinance: arbitrageOpportunity!.galaBuyableOnBinance,
              fees: arbitrageOpportunity!.totalFees,
              pair: arbitrageOpportunity!.pair,
            },
            'Arbitrage opportunity found! Executing trades...',
          );

          await reporter.sendAlert(
            `🚀 Arbitrage Opportunity: ${arbitrageOpportunity!.netProfit.toFixed(2)} GALA profit (${arbitrageOpportunity!.tradeAmount} GALA trade)`,
          );
        }

        // Execute arbitrage trades on both platforms (even if at a loss)
        await this.executeArbitrage(
          logger,
          options.binanceApi,
          options.binanceTrading,
          options.galaChainRouter,
          arbitrageOpportunity!,
          arbitrageOpportunity!.tradeAmount,
          arbitrageOpportunity!.direction || 'GalaSwap->Binance',
        );
      } else if (bestOpportunity) {
        const isGalaToGweth = bestOpportunity.pair === 'GALA/GWETH';
        const minProfitRequired = isGalaToGweth ? this.MIN_PROFIT_GALA_FOR_GWETH : this.MIN_PROFIT_GALA;
        logger.info(
          {
            netProfit: bestOpportunity.netProfit.toFixed(4),
            minRequired: minProfitRequired,
            galaAmount: bestOpportunity.tradeAmount,
            allowLossTrades: this.ALLOW_LOSS_TRADES || isGalaToGweth,
            pair: bestOpportunity.pair,
            note: bestOpportunity.netProfit <= 0 
              ? ((this.ALLOW_LOSS_TRADES || isGalaToGweth)
                  ? `Trade would result in LOSS but ${isGalaToGweth ? 'GALA/GWETH allows small losses' : 'ALLOW_LOSS_TRADES is enabled'} - should execute but opportunity not selected`
                  : 'Trade would result in LOSS - not executing (ALLOW_LOSS_TRADES disabled)')
              : `Profit (${bestOpportunity.netProfit.toFixed(4)}) - will execute (any profit > 0 is allowed)`,
          },
          'Arbitrage: Opportunity found but not executing',
        );
      } else if (arbitrageOpportunity) {
        logger.info(
          {
            netProfit: arbitrageOpportunity.netProfit.toFixed(4),
            minRequired: this.MIN_PROFIT_GALA,
            galaAmount: arbitrageOpportunity.tradeAmount,
            allowLossTrades: this.ALLOW_LOSS_TRADES,
            note: arbitrageOpportunity.netProfit <= 0 
              ? (this.ALLOW_LOSS_TRADES 
                  ? 'Trade would result in LOSS but ALLOW_LOSS_TRADES is enabled - should execute but opportunity not selected'
                  : 'Trade would result in LOSS - not executing (ALLOW_LOSS_TRADES disabled)')
              : 'Profit below minimum threshold',
          },
          'Arbitrage: Opportunity found but not executing',
        );
      } else {
        // Log summary of all opportunities checked
        if (allOpportunities.length > 0) {
          const bestUnprofitable = allOpportunities.reduce((best, opp) => 
            opp.netProfit > best.netProfit ? opp : best
          );
          
          logger.info(
            {
              opportunitiesChecked: allOpportunities.length,
              bestOpportunity: {
                tradeSize: bestUnprofitable.tradeSize,
                netProfit: `${bestUnprofitable.netProfit.toFixed(4)} GALA`,
                pair: bestUnprofitable.pair,
                direction: bestUnprofitable.direction,
                status: bestUnprofitable.netProfit > 0 ? 'Profitable but below minimum' : 'UNPROFITABLE (would lose money)',
              },
              minRequiredProfit: bestUnprofitable.pair === 'GALA/GWETH' 
                ? `${this.MIN_PROFIT_GALA_FOR_GWETH} GALA (special threshold for GALA/GWETH)`
                : `${this.MIN_PROFIT_GALA} GALA`,
              gwethStatus: this.gwethFailureCount >= this.GWETH_MAX_FAILURES 
                ? `Skipped (circuit breaker: ${this.gwethFailureCount} failures)` 
                : 'Checked',
              tokensChecked: arbitrageableTokens.map(t => t.balance.collection),
              note: bestUnprofitable.pair === 'GALA/GWETH' && bestUnprofitable.netProfit >= this.MIN_PROFIT_GALA_FOR_GWETH
                ? 'GALA/GWETH opportunity found but not selected (may be competing with other opportunities)'
                : 'All opportunities are unprofitable. Bot is correctly protecting funds by NOT executing losing trades.',
            },
            'Arbitrage: Check complete - No profitable opportunities found',
          );
        } else {
          logger.info(
            {
              tokensChecked: arbitrageableTokens.map(t => ({
                token: t.balance.collection,
                balance: t.balance.quantity,
              })),
              gwethStatus: this.gwethFailureCount >= this.GWETH_MAX_FAILURES 
                ? `Skipped (circuit breaker: ${this.gwethFailureCount} failures)` 
                : 'Checked',
              note: 'No arbitrage opportunities found (likely due to liquidity issues or price parity)',
            },
            'Arbitrage: No opportunities found across all tokens',
          );
        }
      }
      
      // Always log a summary at the end of each check
      const tokensChecked = arbitrageableTokens.map(t => t.balance.collection);
      const profitableOpps = allOpportunities.filter(o => o.netProfit > 0);
      const unprofitableOpps = allOpportunities.filter(o => o.netProfit <= 0);
      logger.info(
        {
          totalOpportunitiesChecked: allOpportunities.length,
          profitableOpportunities: profitableOpps.length,
          profitableDetails: profitableOpps.length > 0 ? profitableOpps.map(o => ({
            pair: o.pair,
            tradeSize: o.tradeSize,
            netProfit: o.netProfit.toFixed(4),
          })) : 'None found',
          unprofitableOpportunities: unprofitableOpps.length,
          tokensChecked: tokensChecked,
          uniqueTokens: [...new Set(tokensChecked)],
          nextCheckIn: `${Math.round(this.ARBITRAGE_CHECK_INTERVAL / 1000)}s`,
        },
        'Arbitrage: Check cycle complete',
      );
    } catch (error) {
      logger.error(
        {
          error,
        },
        'Failed to check arbitrage opportunity',
      );
    }

    return {
      swapsToTerminate: [],
      swapsToAccept: [],
      swapsToCreate: [],
    };
  }

  /**
   * Check for arbitrage opportunity between GalaSwap and Binance
   * @param receivingToken - Token to receive on GalaSwap (GWETH, GUSDC, or GUSDT)
   * @param binanceSymbol - Binance symbol to use (GALAETH, GALAUSDT)
   * @param quoteCurrency - Quote currency for price conversion (ETHUSDT, USDT)
   */
  private async checkArbitrageOpportunity(
    logger: ILogger,
    binanceApi: IBinanceApi,
    galaChainRouter: GalaChainRouter,
    galaAmount: number,
    galaToken: string = 'GALA',
    receivingToken: string = 'GWETH',
    _binanceSymbol: string = 'GALAETH', // Parameter kept for future use but not currently needed
    quoteCurrency: string = 'ETHUSDT',
  ): Promise<{
    receivingTokenAmount: number;
    galaBuyableOnBinance: number;
    totalFees: number;
    netProfit: number;
    pair: string;
  } | null> {
    try {
      // Step 1: Get GalaSwap quote - How much receivingToken do we get for GALA?
      const galaTokenKey = {
        collection: galaToken,
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };
      const receivingTokenKey = {
        collection: receivingToken,
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };
      
      logger.info(
        {
          tokenIn: `${galaToken}|Unit|none|none`,
          tokenOut: `${receivingToken}|Unit|none|none`,
          amountIn: galaAmount,
          pair: `${galaToken}/${receivingToken}`,
        },
        `Getting GalaSwap quote for ${galaToken} -> ${receivingToken}`,
      );

      let galaSwapQuote;
      try {
        // Force 1% fee tier (10000) for all pairs as per user requirement
        galaSwapQuote = await galaChainRouter.getQuote(
          galaTokenKey,
          receivingTokenKey,
          String(galaAmount),
          10000, // 1% fee tier
        );
      } catch (error: any) {
        // Handle CONFLICT errors - distinguish between different types
        if (error?.code === 409 || error?.key === 'CONFLICT') {
          const errorMessage = error.message || error.key || 'Unknown CONFLICT error';
          const isLiquidityIssue = errorMessage.toLowerCase().includes('liquidity') || 
                                   errorMessage.toLowerCase().includes('not enough');
          
          if (isLiquidityIssue) {
            logger.warn(
              {
                galaAmount,
                pair: `${galaToken}/${receivingToken}`,
                error: errorMessage,
                note: receivingToken === 'GWETH' 
                  ? 'GWETH pool has very low liquidity - this is expected. Try smaller amounts or use alternative pairs (GUSDC/GUSDT).'
                  : 'Pool has insufficient liquidity for this trade size',
              },
              'GalaSwap quote failed: insufficient liquidity in pool',
            );
          } else {
            logger.warn(
              {
                galaAmount,
                pair: `${galaToken}/${receivingToken}`,
                error: errorMessage,
              },
              'GalaSwap quote failed with CONFLICT - amount may be too small',
            );
          }
        } else {
          logger.error(
            {
              galaAmount,
              error,
            },
            'Failed to get GalaSwap quote',
          );
        }
        return null;
      }

      if (!galaSwapQuote) {
        logger.warn('Failed to get GalaSwap quote (null response)');
        return null;
      }

      const receivingTokenAmount = Number(galaSwapQuote.amountOut);
      // IMPORTANT: All pairs use 1% fee tier (10000) as per user requirement
      // The fee is already deducted from amountOut in the quote!
      // Fee tier: 10000 = 1.00% (forced for all pairs)
      const feeTier = 10000; // Always 1% for all pairs
      const actualGalaSwapFeeRate = 0.01; // 1.00% fee rate (10000 / 1000000 = 0.01)
      
      // Calculate the effective fee that was already deducted from the quote
      // This is for logging/reporting only - the fee is already in the quote
      // We estimate the fee by comparing what we'd get without fees vs what we got
      // But since we don't have the "without fees" amount, we'll use a small estimate
      // The actual fee impact is already reflected in the amountOut we received
      
      logger.info(
        {
          galaAmount,
          receivingTokenAmount,
          receivingToken,
          feeTier,
          actualFeeRate: `${(actualGalaSwapFeeRate * 100).toFixed(2)}%`,
        },
        'GalaSwap quote received with actual fee tier',
      );

      // Step 2: Get Binance prices
      // For GWETH: we need ETH/USDT and GALA/USDT prices
      // For GUSDC/GUSDT: we only need GALA/USDT price (stablecoins are 1:1 with USDT, so price = 1.0)
      // For GSOL/GWBTC → GALA: we need the token price (SOLUSDT/BTCUSDT) to convert to USDT value
      const isStablecoin = receivingToken === 'GUSDC' || receivingToken === 'GUSDT';
      
      let quotePriceUsdt: number;
      if (isStablecoin) {
        // Stablecoins are 1:1 with USDT, no need to fetch price
        quotePriceUsdt = 1.0;
      } else if (receivingToken === 'GALA' && (galaToken === 'GSOL' || galaToken === 'GWBTC')) {
        // For GSOL/GWBTC → GALA: We need the input token price (SOLUSDT/BTCUSDT) to calculate USDT value
        // The quoteCurrency should be SOLUSDT for GSOL or BTCUSDT for GWBTC
        const quotePriceResponse = await binanceApi.getPrice(quoteCurrency);
        if (!quotePriceResponse) {
          logger.warn(
            {
              quoteCurrency,
              galaToken,
              receivingToken,
            },
            'Failed to get Binance quote price for token conversion',
          );
          return null;
        }
        quotePriceUsdt = Number(quotePriceResponse.price);
      } else {
        // For GWETH, fetch ETH/USDT price
        const quotePriceResponse = await binanceApi.getPrice(quoteCurrency);
        if (!quotePriceResponse) {
          logger.warn(
            {
              quoteCurrency,
            },
            'Failed to get Binance quote price',
          );
          return null;
        }
        quotePriceUsdt = Number(quotePriceResponse.price);
      }

      // Always need GALA/USDT price
      const galaPriceResponse = await binanceApi.getPrice('GALAUSDT');
      if (!galaPriceResponse) {
        logger.warn(
          {
            missingPrice: 'GALAUSDT',
          },
          'Failed to get Binance GALA price',
        );
        return null;
      }

      const galaPriceUsdt = Number(galaPriceResponse.price);

      logger.info(
        {
          quoteCurrency,
          quotePriceUsdt,
          galaPriceUsdt,
        },
        'Binance prices retrieved',
      );

      // SIMPLE PRICE COMPARISON:
      // Step 3: Calculate effective GALA price on GalaSwap (what we get per GALA sold)
      // Then compare with Binance GALA price
      
      // Convert receiving token to USDT value
      let usdtValue: number;
      if (receivingToken === 'GWETH') {
        // GWETH is 1:1 with ETH
        usdtValue = receivingTokenAmount * quotePriceUsdt;
      } else if (receivingToken === 'GWBTC') {
        // GWBTC is 1:1 with BTC - convert using BTCUSDT price
        usdtValue = receivingTokenAmount * quotePriceUsdt;
      } else if (receivingToken === 'GSOL') {
        // GSOL is 1:1 with SOL - convert using SOLUSDT price
        usdtValue = receivingTokenAmount * quotePriceUsdt;
      } else if (receivingToken === 'GALA') {
        // GALA needs to be converted to USDT using GALA price
        // For GSOL/GWBTC → GALA: receivingTokenAmount is GALA, convert using GALA price
        usdtValue = receivingTokenAmount * galaPriceUsdt;
      } else if (galaToken === 'GSOL' || galaToken === 'GWBTC') {
        // For GSOL/GWBTC → GUSDC: Convert the input token (GSOL/GWBTC) to USDT value
        // galaAmount here is actually the input token amount (GSOL/GWBTC)
        usdtValue = galaAmount * quotePriceUsdt;
      } else {
        // GUSDC/GUSDT are 1:1 with USDT
        usdtValue = receivingTokenAmount;
      }
      
      // Calculate effective price on GalaSwap
      // For GALA → X: USDT per GALA sold
      // For X → GALA: USDT per GALA received (where X is GWETH, GWBTC, etc.)
      // For X → Y (where neither is GALA): Convert to GALA equivalent for comparison
      let galaSwapEffectivePrice: number;
      if (galaToken === 'GALA') {
        // Selling GALA: USDT per GALA sold
        galaSwapEffectivePrice = usdtValue / galaAmount;
      } else if (receivingToken === 'GALA') {
        // Selling other token (GWETH, GWBTC, etc.) for GALA: USDT per GALA received
        // galaAmount here is actually the input token amount, receivingTokenAmount is GALA
        galaSwapEffectivePrice = usdtValue / receivingTokenAmount;
      } else {
        // Neither token is GALA (e.g., GWETH → GUSDC)
        // Convert both to GALA equivalent for comparison
        // Input token value in GALA = (input token amount * token price) / GALA price
        const inputTokenValueInGala = (galaAmount * quotePriceUsdt) / galaPriceUsdt;
        // Output token value in GALA = (output token amount * output token price) / GALA price
        // For stablecoins, output token price = 1.0
        const outputTokenPriceUsdt = (receivingToken === 'GUSDC' || receivingToken === 'GUSDT') ? 1.0 : quotePriceUsdt;
        const outputTokenValueInGala = (receivingTokenAmount * outputTokenPriceUsdt) / galaPriceUsdt;
        // Effective price: GALA equivalent per input token
        galaSwapEffectivePrice = outputTokenValueInGala / inputTokenValueInGala * galaPriceUsdt;
      }
      
      // Binance GALA price (already in USDT)
      const binanceGalaPrice = galaPriceUsdt;
      
      // Calculate how much GALA we can buy back on Binance with the USDT we got
      // For X → Y (neither is GALA), we need to calculate what we could get by selling input token on Binance
      let galaBuyableOnBinance: number;
      if (galaToken === 'GALA') {
        // Selling GALA: How much GALA can we buy back with the USDT we got
        galaBuyableOnBinance = usdtValue / binanceGalaPrice;
      } else if (receivingToken === 'GALA') {
        // Selling other token for GALA: How much GALA can we buy with input token value on Binance
        // Input token value in USDT = input token amount * token price
        const inputTokenValueUsdt = galaAmount * quotePriceUsdt;
        galaBuyableOnBinance = inputTokenValueUsdt / binanceGalaPrice;
      } else {
        // Neither token is GALA (e.g., GWETH → GUSDC)
        // Calculate: How much GALA could we get by selling input token on Binance
        const inputTokenValueUsdt = galaAmount * quotePriceUsdt;
        galaBuyableOnBinance = inputTokenValueUsdt / binanceGalaPrice;
      }
      
      // PRICE GAP: Compare prices directly
      const priceGap = binanceGalaPrice - galaSwapEffectivePrice;
      const priceGapPercent = (priceGap / galaSwapEffectivePrice) * 100;

      logger.info(
        {
          galaSwapEffectivePrice: galaSwapEffectivePrice.toFixed(8),
          binanceGalaPrice: binanceGalaPrice.toFixed(8),
          priceGap: priceGap.toFixed(8),
          priceGapPercent: priceGapPercent.toFixed(2) + '%',
          receivingTokenAmount,
          receivingToken,
          usdtValue,
          galaBuyableOnBinance,
        },
        'Price comparison: GalaSwap vs Binance',
      );

      // Step 4: Calculate fees (using actual rates to minimize)
      // IMPORTANT: GalaSwap fee is already deducted from the quote's amountOut!
      // The fee tier tells us what fee was applied, but we don't need to subtract it again
      // Instead, we estimate the fee cost for profit calculation purposes
      // The actual slippage/fee impact is already in the receivingTokenAmount
      
      // Estimate fee cost: This is approximate since the fee is already in the quote
      // For accurate calculation, we'd need the "before fees" amount, but we can estimate
      // Fee is typically applied to the input amount in DEX swaps
      let estimatedGalaSwapFee: number;
      if (galaToken === 'GALA') {
        // For GALA → X: Fee is on GALA amount
        estimatedGalaSwapFee = galaAmount * actualGalaSwapFeeRate;
      } else {
        // For X → GALA: Fee is on input token (GSOL/GWBTC/GWETH), convert to GALA equivalent
        // We estimate the fee in the input token, then convert to GALA value
        const inputTokenFee = galaAmount * actualGalaSwapFeeRate;
        // Convert input token fee to GALA equivalent using the effective price
        estimatedGalaSwapFee = (inputTokenFee * quotePriceUsdt) / galaPriceUsdt;
      }
      
      // Binance trading fee: Use maker fee rate (0.02%) for limit orders (80% savings!)
      // This is the PRIMARY optimization to make minor profits achievable
      const binanceFeeRate = this.USE_LIMIT_ORDERS ? this.BINANCE_MAKER_FEE_RATE : this.BINANCE_MARKET_FEE_RATE;
      // For X → Y (neither is GALA), calculate fee based on input token value
      let binanceFee: number;
      if (galaToken === 'GALA' || receivingToken === 'GALA') {
        // Standard case: Fee is on GALA amount
        binanceFee = galaBuyableOnBinance * binanceFeeRate;
      } else {
        // Neither token is GALA: Fee is on the input token value in USDT
        const inputTokenValueUsdt = galaAmount * quotePriceUsdt;
        binanceFee = (inputTokenValueUsdt * binanceFeeRate) / galaPriceUsdt; // Convert to GALA equivalent
      }
      
      // Gas fee (optimized estimate)
      const gasFee = this.GAS_FEE_GALA;
      
      const totalFees = estimatedGalaSwapFee + binanceFee + gasFee;
      
      // Calculate potential savings if using limit orders
      const potentialMakerFee = galaBuyableOnBinance * this.BINANCE_MAKER_FEE_RATE;
      const feeSavings = binanceFee - potentialMakerFee;

      // Step 5: Calculate net profit from price gap
      // For GALA → X: Compare GALA sold vs GALA buyable back
      // For X → GALA: Compare input token value (in GALA) vs GALA received
      let netProfit: number;
      if (galaToken === 'GALA') {
        // Selling GALA: Simple comparison - how much GALA can we buy back vs what we sold
        netProfit = galaBuyableOnBinance - galaAmount - totalFees;
      } else {
        // Selling other token (GSOL/GWBTC/GWETH) for GALA:
        // Compare: GALA received vs what we could have gotten by selling the input token on Binance
        // Input token value in GALA = (input token amount * token price) / GALA price
        const inputTokenValueInGala = (galaAmount * quotePriceUsdt) / galaPriceUsdt;
        // Profit = GALA received - input token value in GALA - fees
        netProfit = receivingTokenAmount - inputTokenValueInGala - totalFees;
      }
      
      // Alternative calculation: Price gap in GALA terms
      const priceGapInGala = (priceGap * galaAmount) / binanceGalaPrice;

        logger.info(
          {
            priceComparison: {
              galaSwapPrice: galaSwapEffectivePrice.toFixed(8),
              binancePrice: binanceGalaPrice.toFixed(8),
              priceGap: priceGap.toFixed(8),
              priceGapPercent: priceGapPercent.toFixed(2) + '%',
            },
            trade: {
            galaSold: galaToken === 'GALA' ? galaAmount : `${galaAmount} ${galaToken}`,
            galaReceived: receivingToken === 'GALA' ? receivingTokenAmount : `${receivingTokenAmount} ${receivingToken}`,
            galaBuyableOnBinance: galaToken === 'GALA' ? galaBuyableOnBinance : 'N/A (different token)',
            },
            fees: {
              galaSwapFee: estimatedGalaSwapFee.toFixed(4),
              galaSwapFeeRate: `${(actualGalaSwapFeeRate * 100).toFixed(2)}%`,
              binanceFee: binanceFee.toFixed(4),
              binanceFeeRate: `${(binanceFeeRate * 100).toFixed(2)}%`,
              binanceOrderType: this.USE_LIMIT_ORDERS ? 'LIMIT (maker)' : 'MARKET',
              gasFee: gasFee.toFixed(4),
              totalFees: totalFees.toFixed(4),
            },
            profit: {
            netProfit: netProfit.toFixed(4),
              priceGapInGala: priceGapInGala.toFixed(4),
            },
          },
          'Price gap arbitrage: Price comparison complete',
        );

      // Filter: Only return opportunity if trade value meets Binance minimum notional ($10)
      // For GWETH/GWBTC/GSOL → GALA: Check if GALA amount meets minimum
      // For GALA → GWETH/GUSDC/GUSDT: Check if GALA amount meets minimum
      const BINANCE_MIN_NOTIONAL = 10; // Binance minimum trade value
      let tradeValueUsdt: number;
      
      if (galaToken === 'GALA') {
        // Selling GALA: Check if GALA amount * GALA price >= $10
        tradeValueUsdt = galaAmount * galaPriceUsdt;
      } else {
        // Selling other token for GALA: Check if received GALA amount * GALA price >= $10
        tradeValueUsdt = receivingTokenAmount * galaPriceUsdt;
      }

      if (tradeValueUsdt < BINANCE_MIN_NOTIONAL) {
        logger.debug(
          {
            galaToken,
            receivingToken,
            tradeSize: galaToken === 'GALA' ? galaAmount : receivingTokenAmount,
            tradeValueUsdt: tradeValueUsdt.toFixed(2),
            minimumRequired: BINANCE_MIN_NOTIONAL,
            note: 'Trade value below Binance minimum - skipping opportunity',
          },
          'Skipping arbitrage opportunity: Trade value too small (below $10 minimum)',
        );
        return null; // Skip opportunities below $10 minimum
      }

      return {
        receivingTokenAmount,
        galaBuyableOnBinance,
        totalFees,
        netProfit,
        pair: `${galaToken}/${receivingToken}`,
      };
    } catch (error) {
      logger.error(
        {
          error,
        },
        'Error checking arbitrage opportunity',
      );
      return null;
    }
  }

  /**
   * Check reverse arbitrage opportunity: Buy GALA on Binance, sell on GalaSwap
   * This is profitable when GALA is cheaper on Binance than on GalaSwap
   */
  private async checkReverseArbitrageOpportunity(
    logger: ILogger,
    binanceApi: IBinanceApi,
    galaChainRouter: GalaChainRouter,
    galaAmount: number,
    usdtNeeded: number,
  ): Promise<{
    receivingTokenAmount: number;
    galaBuyableOnBinance: number;
    totalFees: number;
    netProfit: number;
    pair: string;
  } | null> {
    try {
      // Step 1: Get GALA price on Binance
      const galaPriceResponse = await binanceApi.getPrice('GALAUSDT');
      if (!galaPriceResponse) {
        return null;
      }
      const galaPriceUsdt = Number(galaPriceResponse.price);

      // Step 2: Calculate cost to buy GALA on Binance (including fees)
      // OPTIMIZED: Use maker fee rate (0.02%) for limit orders
      const binanceFeeRate = this.USE_LIMIT_ORDERS ? this.BINANCE_MAKER_FEE_RATE : this.BINANCE_MARKET_FEE_RATE;
      const binanceBuyFee = galaAmount * galaPriceUsdt * binanceFeeRate;
      const totalCostUsdt = usdtNeeded + binanceBuyFee;

      // Step 3: Get quote from GalaSwap: How much token do we get for selling GALA?
      // Try GALA -> GUSDC first (most liquid)
      const galaTokenKey = {
        collection: 'GALA',
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };
      
      const receivingTokenKey = {
        collection: 'GUSDC',
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };

      let galaSwapQuote;
      try {
        // Force 1% fee tier (10000) for all pairs as per user requirement
        galaSwapQuote = await galaChainRouter.getQuote(
          galaTokenKey,
          receivingTokenKey,
          String(galaAmount),
          10000, // 1% fee tier
        );
      } catch (error: any) {
        logger.debug(
          {
            galaAmount,
            error: error?.message || error?.key,
          },
          'Failed to get GalaSwap quote for reverse arbitrage',
        );
        return null;
      }

      if (!galaSwapQuote) {
        return null;
      }

      const receivingTokenAmount = Number(galaSwapQuote.amountOut);
      // GUSDC is 1:1 with USDT, so this is the USDT value we get
      const usdtReceived = receivingTokenAmount;

      // Step 4: Calculate fees (minimized)
      // IMPORTANT: All pairs use 1% fee tier (10000) as per user requirement
      const feeTier = 10000; // Always 1% for all pairs
      const actualGalaSwapFeeRate = 0.01; // 1.00% fee rate (10000 / 1000000 = 0.01)
      const estimatedGalaSwapFee = galaAmount * actualGalaSwapFeeRate;
      const gasFee = this.GAS_FEE_GALA;
      const totalFees = binanceBuyFee + estimatedGalaSwapFee + gasFee;

      // Step 5: Calculate net profit
      // Net profit = (USDT received from GalaSwap) - (USDT spent on Binance) - (All Fees)
      const netProfit = usdtReceived - totalCostUsdt - totalFees;
      
      // Convert profit to GALA for consistency
      const netProfitGala = netProfit / galaPriceUsdt;

      logger.info(
        {
          direction: 'Binance->GalaSwap',
          galaBought: galaAmount,
          usdtSpent: totalCostUsdt.toFixed(4),
          usdtReceived: usdtReceived.toFixed(4),
          receivingToken: 'GUSDC',
          receivingTokenAmount: receivingTokenAmount.toFixed(4),
          binanceFee: binanceBuyFee.toFixed(4),
          galaSwapFee: estimatedGalaSwapFee.toFixed(4),
          gasFee,
          totalFees: totalFees.toFixed(4),
          netProfitUsdt: netProfit.toFixed(4),
          netProfitGala: netProfitGala.toFixed(4),
        },
        'Reverse arbitrage calculation complete',
      );

      // Filter: Only return opportunity if trade value meets Binance minimum notional ($10)
      // For reverse arbitrage: Check if GALA amount * GALA price >= $10
      const BINANCE_MIN_NOTIONAL = 10; // Binance minimum trade value
      const tradeValueUsdt = galaAmount * galaPriceUsdt;

      if (tradeValueUsdt < BINANCE_MIN_NOTIONAL) {
        logger.debug(
          {
            galaAmount,
            tradeValueUsdt: tradeValueUsdt.toFixed(2),
            minimumRequired: BINANCE_MIN_NOTIONAL,
            note: 'Trade value below Binance minimum - skipping reverse opportunity',
          },
          'Skipping reverse arbitrage opportunity: Trade value too small (below $10 minimum)',
        );
        return null; // Skip opportunities below $10 minimum
      }

      return {
        receivingTokenAmount,
        galaBuyableOnBinance: galaAmount, // We bought this amount
        totalFees,
        netProfit: netProfitGala, // Return profit in GALA for consistency
        pair: 'GALA/GUSDC',
      };
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error checking reverse arbitrage opportunity',
      );
      return null;
    }
  }

  /**
   * Execute arbitrage trades on both platforms simultaneously
   * Direction: 'GalaSwap->Binance' or 'Binance->GalaSwap'
   */
  private async executeArbitrage(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    galaChainRouter: GalaChainRouter,
    opportunity: {
      receivingTokenAmount: number;
      galaBuyableOnBinance: number;
      totalFees: number;
      netProfit: number;
      pair: string;
    },
    galaAmount: number,
    direction: 'GalaSwap->Binance' | 'Binance->GalaSwap' = 'GalaSwap->Binance',
  ): Promise<void> {
    try {
      logger.info(
        {
          netProfit: opportunity.netProfit,
          direction,
          galaAmount,
          pair: opportunity.pair,
        },
        '🚀 Starting arbitrage execution on BOTH platforms',
      );

      if (direction === 'Binance->GalaSwap') {
        // Reverse direction: Buy GALA on Binance first, then sell on GalaSwap
        await this.executeReverseArbitrage(
          logger,
          binanceApi,
          binanceTrading,
          galaChainRouter,
          opportunity,
          galaAmount,
        );
        return;
      }

      // Forward direction: Sell token on GalaSwap first, then buy on Binance
      // Parse the pair to determine tokens
      const pairParts = opportunity.pair.split('/');
      const tokenIn = pairParts[0] || 'GALA'; // e.g., 'GALA', 'GWETH'
      const receivingToken = pairParts[1] || 'GWETH'; // e.g., 'GWETH', 'GUSDC', 'GUSDT'
      
      // Check if this is a GWETH → GALA swap (use direct swap method with high-volume Binance mirror)
      if (tokenIn === 'GWETH' && receivingToken === 'GALA') {
        const gwethAmount = galaAmount; // In this case, galaAmount is actually GWETH amount
        
        // Pre-check: Verify Binance mirror will be possible before executing GalaSwap
        const expectedGalaAmount = opportunity.receivingTokenAmount;
        const galaPrice = await binanceApi.getPrice('GALAUSDT');
        if (!galaPrice) {
          logger.warn(
            {
              gwethAmount,
              expectedGalaAmount,
              note: 'Cannot verify Binance mirror feasibility - skipping trade',
            },
            '⚠️ Skipping GWETH → GALA trade: Cannot fetch GALA price for Binance check',
          );
          return;
        }

        const galaPriceUsdt = Number(galaPrice.price);
        const expectedTradeValueUsdt = expectedGalaAmount * galaPriceUsdt;
        const BINANCE_MIN_NOTIONAL = 10; // Binance minimum trade value

        if (expectedTradeValueUsdt < BINANCE_MIN_NOTIONAL) {
          logger.warn(
            {
              gwethAmount,
              expectedGalaAmount,
              galaPriceUsdt: galaPriceUsdt.toFixed(6),
              expectedTradeValueUsdt: expectedTradeValueUsdt.toFixed(2),
              minimumRequired: BINANCE_MIN_NOTIONAL,
              note: 'Expected trade value below Binance minimum - skipping to avoid one-sided trade',
            },
            '⚠️ Skipping GWETH → GALA trade: Expected Binance mirror value too small (below $10 minimum)',
          );
          return; // Don't execute GalaSwap if Binance mirror won't work
        }
      
      logger.info(
        {
            tokenIn: 'GWETH|Unit|none|none',
            tokenOut: 'GALA|Unit|none|none',
            amountIn: gwethAmount,
            pair: opportunity.pair,
            expectedGalaAmount,
            expectedTradeValueUsdt: expectedTradeValueUsdt.toFixed(2),
          },
          `Executing GalaSwap trade: GWETH → GALA (direct swap with high-volume Binance mirror)`,
        );

        // Use direct GWETH → GALA swap method
        const galaSwapResult = await galaChainRouter.executeDirectGwethToGalaSwap(
          String(gwethAmount),
          0.95, // 5% slippage tolerance
        );

        // Success gate - only proceed if GalaChain swap succeeded
        if (!galaSwapResult.success) {
          logger.error(
            {
              transactionId: galaSwapResult.transactionId,
              message: 'GalaChain swap failed - aborting Binance mirror',
            },
            '❌ GalaSwap Transaction Failed. Binance trade aborted.',
          );
          return;
        }

        const receivedGala = Number(galaSwapResult.galaAmount);
        logger.info(
          {
            transactionId: galaSwapResult.transactionId,
            gwethAmount: gwethAmount,
            galaAmount: receivedGala,
          },
          '✨ GalaSwap Success! Received GALA - Proceeding to Binance mirror',
        );

        // Step 2: Mirror on Binance: Sell ETH → USDT → Buy GALA
        // Flow: GalaSwap: Sell GWETH → Get GALA | Binance: Sell ETH → USDT → Buy GALA (to mirror GALA)
        await this.mirrorGwethToBinanceReverse(
          logger,
          binanceApi,
          binanceTrading,
          gwethAmount, // Use original GWETH amount to calculate ETH to sell
        );

        logger.info(
          {
            gwethAmount: gwethAmount,
            galaAmount: receivedGala,
            netProfit: opportunity.netProfit,
          },
          '✅ GWETH arbitrage execution complete on BOTH platforms!',
        );
        return;
      }

      // Check if this is a GWBTC → GALA swap (use standard swap method with Binance mirror)
      if (tokenIn === 'GWBTC' && receivingToken === 'GALA') {
        const gwbtcAmount = galaAmount; // In this case, galaAmount is actually GWBTC amount
        
        // Pre-check: Verify Binance mirror will be possible before executing GalaSwap
        const expectedGalaAmount = opportunity.receivingTokenAmount;
        const galaPrice = await binanceApi.getPrice('GALAUSDT');
        if (!galaPrice) {
          logger.warn(
            {
              gwbtcAmount,
              expectedGalaAmount,
              note: 'Cannot verify Binance mirror feasibility - skipping trade',
            },
            '⚠️ Skipping GWBTC → GALA trade: Cannot fetch GALA price for Binance check',
          );
          return;
        }

        const galaPriceUsdt = Number(galaPrice.price);
        const expectedTradeValueUsdt = expectedGalaAmount * galaPriceUsdt;
        const BINANCE_MIN_NOTIONAL = 10; // Binance minimum trade value

        if (expectedTradeValueUsdt < BINANCE_MIN_NOTIONAL) {
          logger.warn(
            {
              gwbtcAmount,
              expectedGalaAmount,
              galaPriceUsdt: galaPriceUsdt.toFixed(6),
              expectedTradeValueUsdt: expectedTradeValueUsdt.toFixed(2),
              minimumRequired: BINANCE_MIN_NOTIONAL,
              note: 'Expected trade value below Binance minimum - skipping to avoid one-sided trade',
            },
            '⚠️ Skipping GWBTC → GALA trade: Expected Binance mirror value too small (below $10 minimum)',
          );
          return; // Don't execute GalaSwap if Binance mirror won't work
        }

        logger.info(
          {
            tokenIn: 'GWBTC|Unit|none|none',
            tokenOut: 'GALA|Unit|none|none',
            amountIn: gwbtcAmount,
            pair: opportunity.pair,
            expectedGalaAmount,
            expectedTradeValueUsdt: expectedTradeValueUsdt.toFixed(2),
          },
          `Executing GalaSwap trade: GWBTC → GALA (with Binance mirror)`,
        );

        // Use standard swap method for GWBTC → GALA
        const galaSwapResult = await galaChainRouter.requestSwap({
          offered: [
            {
              quantity: String(gwbtcAmount),
              tokenInstance: {
                collection: 'GWBTC',
                category: 'Unit',
                type: 'none',
                additionalKey: 'none',
              },
            },
          ],
          wanted: [
            {
              quantity: String(opportunity.receivingTokenAmount),
              tokenInstance: {
                collection: 'GALA',
                category: 'Unit',
                type: 'none',
                additionalKey: 'none',
              },
            },
          ],
        });

        logger.info(
          {
            transactionId: galaSwapResult.transactionId,
            gwbtcAmount: gwbtcAmount,
            galaAmount: opportunity.receivingTokenAmount,
          },
          '✅ GalaSwap trade executed successfully for GWBTC → GALA',
        );

        // Step 2: Mirror on Binance using high-volume path (GALA → USDT → BTC)
        const receivedGala = opportunity.receivingTokenAmount;
        await this.mirrorGalaToBinanceHighVolume(
          logger,
          binanceApi,
          binanceTrading,
          receivedGala,
        );

        logger.info(
          {
            gwbtcAmount: gwbtcAmount,
            galaAmount: receivedGala,
            netProfit: opportunity.netProfit,
          },
          '✅ GWBTC arbitrage execution complete on BOTH platforms!',
        );
        return;
      }

      // Check if this is a GSOL → GALA swap (use standard swap method with Binance mirror)
      if (tokenIn === 'GSOL' && receivingToken === 'GALA') {
        const gsolAmount = galaAmount; // In this case, galaAmount is actually GSOL amount
        
        // Pre-check: Verify Binance mirror will be possible before executing GalaSwap
        const expectedGalaAmount = opportunity.receivingTokenAmount;
        const galaPrice = await binanceApi.getPrice('GALAUSDT');
        if (!galaPrice) {
          logger.warn(
            {
              gsolAmount,
              expectedGalaAmount,
              note: 'Cannot verify Binance mirror feasibility - skipping trade',
            },
            '⚠️ Skipping GSOL → GALA trade: Cannot fetch GALA price for Binance check',
          );
          return;
        }

        const galaPriceUsdt = Number(galaPrice.price);
        const expectedTradeValueUsdt = expectedGalaAmount * galaPriceUsdt;
        const BINANCE_MIN_NOTIONAL = 10; // Binance minimum trade value

        if (expectedTradeValueUsdt < BINANCE_MIN_NOTIONAL) {
          logger.warn(
            {
              gsolAmount,
              expectedGalaAmount,
              galaPriceUsdt: galaPriceUsdt.toFixed(6),
              expectedTradeValueUsdt: expectedTradeValueUsdt.toFixed(2),
              minimumRequired: BINANCE_MIN_NOTIONAL,
              note: 'Expected trade value below Binance minimum - skipping to avoid one-sided trade',
            },
            '⚠️ Skipping GSOL → GALA trade: Expected Binance mirror value too small (below $10 minimum)',
          );
          return; // Don't execute GalaSwap if Binance mirror won't work
        }

        logger.info(
          {
            tokenIn: 'GSOL|Unit|none|none',
            tokenOut: 'GALA|Unit|none|none',
            amountIn: gsolAmount,
            pair: opportunity.pair,
            expectedGalaAmount,
            expectedTradeValueUsdt: expectedTradeValueUsdt.toFixed(2),
          },
          `Executing GalaSwap trade: GSOL → GALA (with Binance mirror)`,
        );

        // Use standard swap method for GSOL → GALA
        const galaSwapResult = await galaChainRouter.requestSwap({
          offered: [
            {
              quantity: String(gsolAmount),
              tokenInstance: {
                collection: 'GSOL',
                category: 'Unit',
                type: 'none',
                additionalKey: 'none',
              },
            },
          ],
          wanted: [
            {
              quantity: String(opportunity.receivingTokenAmount),
              tokenInstance: {
                collection: 'GALA',
                category: 'Unit',
                type: 'none',
                additionalKey: 'none',
              },
            },
          ],
        });

        logger.info(
          {
            transactionId: galaSwapResult.transactionId,
            gsolAmount: gsolAmount,
            galaAmount: opportunity.receivingTokenAmount,
          },
          '✅ GalaSwap trade executed successfully for GSOL → GALA',
        );

        // Step 2: Mirror on Binance using high-volume path (GALA → USDT → SOL)
        const receivedGala = opportunity.receivingTokenAmount;
        await this.mirrorGalaToBinanceForToken(
          logger,
          binanceApi,
          binanceTrading,
          receivedGala,
          'SOL', // Target token: SOL
          'SOLUSDT', // Binance symbol
        );

        logger.info(
          {
            gsolAmount: gsolAmount,
            galaAmount: receivedGala,
            netProfit: opportunity.netProfit,
          },
          '✅ GSOL arbitrage execution complete on BOTH platforms!',
        );
        return;
      }

      // Standard flow: GALA → receiving token
      logger.info(
        {
          tokenIn: `${tokenIn}|Unit|none|none`,
          tokenOut: `${receivingToken}|Unit|none|none`,
          amountIn: galaAmount,
          pair: opportunity.pair,
        },
        `Executing GalaSwap trade: Selling ${tokenIn} for ${receivingToken}`,
      );

      const galaSwapResult = await galaChainRouter.requestSwap({
        offered: [
          {
            quantity: String(galaAmount),
            tokenInstance: {
              collection: tokenIn,
              category: 'Unit',
              type: 'none',
              additionalKey: 'none',
            },
          },
        ],
        wanted: [
          {
            quantity: String(opportunity.receivingTokenAmount),
            tokenInstance: {
              collection: receivingToken,
              category: 'Unit',
              type: 'none',
              additionalKey: 'none',
            },
          },
        ],
      });

      logger.info(
        {
          transactionId: galaSwapResult.transactionId,
          status: galaSwapResult.status,
          galaSold: galaAmount,
          receivingToken,
          receivingTokenAmount: opportunity.receivingTokenAmount,
        },
        '✅ GalaSwap trade executed successfully',
      );

      // Step 2: Execute Binance trade (Buy GALA)
      // For GWETH: Use GALAETH pair
      // For GUSDC/GUSDT: Use GALAUSDT pair
      // For GSOL: Use high-volume path (GALA → USDT → SOL)
      // For GWBTC: Use high-volume path (GALA → USDT → BTC)
      
      // Check if this is GALA → GSOL (mirror: sell SOL for USDT, then buy GALA)
      if (tokenIn === 'GALA' && receivingToken === 'GSOL') {
        const receivedGsol = opportunity.receivingTokenAmount;
        logger.info(
          {
            galaAmount,
            receivedGsol,
            route: 'SOL → USDT → GALA',
          },
          '🔄 Mirroring GALA → GSOL on Binance: SOL → USDT → GALA',
        );
        
        // Step 1: Sell SOL for USDT on Binance
        const solPrice = await binanceApi.getPrice('SOLUSDT');
        if (!solPrice) {
          throw new Error('Could not get SOLUSDT price for Binance mirror');
        }
        const solPriceUsdt = Number(solPrice.price);
        const usdtValue = receivedGsol * solPriceUsdt;
        
        // Step 2: Buy GALA with USDT
        if (usdtValue < 10) {
          logger.warn(
            {
              receivedGsol,
              usdtValue: usdtValue.toFixed(2),
              minimumRequired: 10,
              note: 'Trade value below Binance minimum - skipping mirror',
            },
            '⚠️ Skipping Binance mirror: Trade value too small (below $10 minimum)',
          );
          return;
        }
        
        // Use market order to buy GALA with USDT
        await binanceTrading.executeTradeForArbitrage({
          symbol: 'GALAUSDT',
              side: 'BUY',
          type: 'MARKET',
          quantity: String(usdtValue), // For market buy, quantity is in quote currency (USDT)
        });
        
        logger.info(
          {
            galaAmount,
            receivedGsol,
            usdtValue: usdtValue.toFixed(2),
            netProfit: opportunity.netProfit,
          },
          '✅ GALA → GSOL arbitrage execution complete on BOTH platforms!',
        );
        return;
      }
      
      // Check if this is GALA → GWBTC (mirror: sell BTC for USDT, then buy GALA)
      if (tokenIn === 'GALA' && receivingToken === 'GWBTC') {
        const receivedGwbct = opportunity.receivingTokenAmount;
        logger.info(
          {
            galaAmount,
            receivedGwbct,
            route: 'BTC → USDT → GALA',
          },
          '🔄 Mirroring GALA → GWBTC on Binance: BTC → USDT → GALA',
        );
        
        // Step 1: Sell BTC for USDT on Binance
        const btcPrice = await binanceApi.getPrice('BTCUSDT');
        if (!btcPrice) {
          throw new Error('Could not get BTCUSDT price for Binance mirror');
        }
        const btcPriceUsdt = Number(btcPrice.price);
        const usdtValue = receivedGwbct * btcPriceUsdt;
        
        // Step 2: Buy GALA with USDT
        if (usdtValue < 10) {
          logger.warn(
            {
              receivedGwbct,
              usdtValue: usdtValue.toFixed(2),
              minimumRequired: 10,
              note: 'Trade value below Binance minimum - skipping mirror',
            },
            '⚠️ Skipping Binance mirror: Trade value too small (below $10 minimum)',
          );
          return;
        }
        
        // Use market order to buy GALA with USDT
          await binanceTrading.executeTradeForArbitrage({
          symbol: 'GALAUSDT',
            side: 'BUY',
            type: 'MARKET',
          quantity: String(usdtValue), // For market buy, quantity is in quote currency (USDT)
          });

          logger.info(
            {
            galaAmount,
            receivedGwbct,
            usdtValue: usdtValue.toFixed(2),
              netProfit: opportunity.netProfit,
            },
          '✅ GALA → GWBTC arbitrage execution complete on BOTH platforms!',
          );
          return;
        }
      
      if (receivingToken === 'GWETH') {
        // Check if this is GUSDC/GUSDT → GWETH (different logic needed)
        if (tokenIn === 'GUSDC' || tokenIn === 'GUSDT') {
          // For stablecoin → GWETH: Buy ETH on Binance with USDT
          const ethAmount = opportunity.receivingTokenAmount; // GWETH is 1:1 with ETH
          const ethPrice = await binanceApi.getPrice('ETHUSDT');
          if (!ethPrice) {
            throw new Error('Could not get ETHUSDT price for Binance mirror');
          }
          const ethPriceUsdt = Number(ethPrice.price);
          const usdtNeeded = ethAmount * ethPriceUsdt;
          
          logger.info(
            {
              tokenIn,
              receivedGweth: ethAmount,
              usdtNeeded: usdtNeeded.toFixed(2),
              route: 'USDT → ETH',
            },
            `🔄 Mirroring ${tokenIn} → GWETH on Binance: Buying ETH with USDT`,
          );
          
          // Check minimum notional
          if (usdtNeeded < 10) {
            logger.warn(
              {
                receivedGweth: ethAmount,
                usdtNeeded: usdtNeeded.toFixed(2),
                minimumRequired: 10,
                note: 'Trade value below Binance minimum - skipping mirror',
              },
              '⚠️ Skipping Binance mirror: Trade value too small (below $10 minimum)',
            );
            return;
          }
          
          // Buy ETH with USDT on Binance
          await binanceTrading.executeTradeForArbitrage({
            symbol: 'ETHUSDT',
            side: 'BUY',
            type: 'MARKET',
            quantity: String(usdtNeeded), // For market buy, quantity is in quote currency (USDT)
          });
          
          logger.info(
            {
              tokenIn,
              receivedGweth: ethAmount,
              usdtNeeded: usdtNeeded.toFixed(2),
              netProfit: opportunity.netProfit,
            },
            `✅ ${tokenIn} → GWETH arbitrage execution complete on BOTH platforms!`,
          );
          return;
        }
        
        // For GALA → GWETH: Mirror by selling GALA → USDT → buying ETH
        // Flow: GalaSwap: Sell GALA → Get GWETH | Binance: Sell GALA → USDT → Buy ETH (to mirror GWETH)
        const ethAmount = opportunity.receivingTokenAmount; // GWETH is 1:1 with ETH
        
        // Pre-check: Verify we have enough GALA on Binance to sell
        const galaPrice = await binanceApi.getPrice('GALAUSDT');
        if (!galaPrice) {
          throw new Error('Could not get GALAUSDT price for Binance mirror');
        }
        const galaPriceUsdt = Number(galaPrice.price);
        const tradeValueUsdt = galaAmount * galaPriceUsdt;
        const BINANCE_MIN_NOTIONAL = 10;
        
        if (tradeValueUsdt < BINANCE_MIN_NOTIONAL) {
        logger.warn(
          {
              galaAmount,
              galaPriceUsdt: galaPriceUsdt.toFixed(6),
              tradeValueUsdt: tradeValueUsdt.toFixed(2),
              minimumRequired: BINANCE_MIN_NOTIONAL,
              note: 'Trade value below Binance minimum - skipping mirror',
            },
            '⚠️ Skipping Binance mirror: Trade value too small (below $10 minimum)',
          );
          return;
        }
        
        logger.info(
          {
            galaAmount,
            receivedGweth: ethAmount,
            route: 'GALA → USDT → ETH',
          },
          '🔄 Mirroring GALA → GWETH on Binance: Selling GALA → USDT → Buying ETH',
        );
        
        // Step 1: Sell GALA for USDT
        logger.info(
          {
            symbol: 'GALAUSDT',
            side: 'SELL',
            galaAmount,
          },
          '📉 Step 1: Selling GALA for USDT',
        );
        
        const galaOrder = await binanceTrading.executeTradeForArbitrage({
          symbol: 'GALAUSDT',
          side: 'SELL',
          type: 'MARKET',
          quantity: String(galaAmount),
        });
        
        // Get USDT received from the order
        let usdtReceived = galaOrder.cummulativeQuoteQty ? Number(galaOrder.cummulativeQuoteQty) : 0;
        
        // Fallback: If cummulativeQuoteQty is 0 or missing, fetch balance
        if (!usdtReceived || usdtReceived === 0) {
          logger.info('⏳ Fetching live USDT balance...');
          const balances = await binanceApi.getBalances();
          const usdtBalance = balances.get('USDT');
          usdtReceived = usdtBalance ? Number(usdtBalance.free) : 0;
        }
        
        logger.info(
          {
            usdtReceived: usdtReceived.toFixed(2),
            galaOrderId: galaOrder.orderId,
          },
          '✅ Step 1 complete: GALA sold for USDT',
        );
        
        // Step 2: Buy ETH with USDT
        const ethPrice = await binanceApi.getPrice('ETHUSDT');
        if (!ethPrice) {
          throw new Error('Could not get ETHUSDT price for Binance mirror');
        }
        
        logger.info(
          {
            symbol: 'ETHUSDT',
            side: 'BUY',
            usdtAmount: usdtReceived.toFixed(2),
          },
          '📈 Step 2: Buying ETH with USDT',
        );
        
        // Buy ETH with USDT on Binance (to mirror the GWETH we received on GalaSwap)
        const ethOrder = await binanceTrading.executeTradeForArbitrage({
          symbol: 'ETHUSDT',
          side: 'BUY',
          type: 'MARKET',
          quantity: String(usdtReceived), // For market buy, quantity is in quote currency (USDT)
        });
        
        logger.info(
          {
            galaAmount,
            receivedGweth: ethAmount,
            usdtReceived: usdtReceived.toFixed(2),
            ethOrderId: ethOrder.orderId,
            netProfit: opportunity.netProfit,
          },
          '✅ GALA → GWETH arbitrage execution complete on BOTH platforms! (GALA → USDT → ETH)',
        );
        return;
      } else if (receivingToken === 'GUSDC' || receivingToken === 'GUSDT') {
        // For stablecoins, use GALAUSDT pair directly
        // The receivingTokenAmount is already in USDT (1:1)
        const usdtAmount = opportunity.receivingTokenAmount;
        
        logger.info(
          {
            symbol: 'GALAUSDT',
            side: 'BUY',
            usdtAmount,
            expectedGala: opportunity.galaBuyableOnBinance,
          },
          'Executing Binance trade: Buying GALA with USDT (GALAUSDT pair)',
        );

        // For small amounts (< $10), use MARKET orders to avoid price precision issues
        // For larger amounts, use LIMIT orders with maker pricing (0.02% fee)
        if (!binanceTrading) {
          throw new Error('BinanceTrading is not available - cannot execute Binance trade');
        }
        
        if (usdtAmount < 10) {
          // Small amount: Use MARKET order (simpler, avoids price precision issues)
          logger.info(
            {
              note: 'Using MARKET order for small amount to avoid price precision issues',
              usdtAmount,
            },
            'Using MARKET order for small trade',
          );
        
        await binanceTrading.executeTradeForArbitrage({
          symbol: 'GALAUSDT',
          side: 'BUY',
          type: 'MARKET',
            quantity: String(usdtAmount), // For market buy, quantity is in quote currency (USDT)
          });
        } else {
          // Larger amount: Use LIMIT order with maker pricing (0.02% fee)
          const galaUsdtPriceResponse = await binanceApi.getPrice('GALAUSDT');
          if (!galaUsdtPriceResponse) {
            throw new Error('Could not get GALAUSDT price for limit order');
          }
          const currentPrice = Number(galaUsdtPriceResponse.price);
          // Calculate GALA amount first, then use proper formatting
          const galaQuantity = Math.floor(usdtAmount / currentPrice); // Round down to whole GALA
          
          // Use current price (don't add premium) - let it fill as maker naturally
          // The formatPrice method will handle proper precision
          await binanceTrading.executeTradeForArbitrage({
            symbol: 'GALAUSDT',
            side: 'BUY',
            type: 'LIMIT',
            quantity: String(galaQuantity),
            price: String(currentPrice), // Use current price - formatPrice will handle precision
            timeInForce: 'GTC', // Good Till Canceled
          });
        }

        logger.info(
          {
            netProfit: opportunity.netProfit,
            galaReceived: opportunity.galaBuyableOnBinance,
            pair: opportunity.pair,
            usdtSpent: opportunity.receivingTokenAmount,
          },
          '✅ Forward arbitrage execution complete on BOTH platforms!',
        );
      } else {
        logger.warn(
          {
            receivingToken,
            pair: opportunity.pair,
          },
          'Unknown receiving token - cannot execute Binance trade',
        );
      }
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          errorStack: error?.stack,
          errorType: error?.constructor?.name,
          opportunity,
          direction,
        },
        'Failed to execute arbitrage trades',
      );
      throw error;
    }
  }

  /**
   * Execute reverse arbitrage: Buy GALA on Binance, then sell on GalaSwap
   */
  private async executeReverseArbitrage(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    galaChainRouter: GalaChainRouter,
    opportunity: {
      receivingTokenAmount: number;
      galaBuyableOnBinance: number;
      totalFees: number;
      netProfit: number;
      pair: string;
    },
    galaAmount: number,
  ): Promise<void> {
    try {
      logger.info(
        {
          direction: 'Binance->GalaSwap',
          galaAmount,
          pair: opportunity.pair,
        },
        'Executing reverse arbitrage: Step 1 - Buying GALA on Binance',
      );

      // Step 1: Buy GALA on Binance with USDT
      const galaPriceResponse = await binanceApi.getPrice('GALAUSDT');
      if (!galaPriceResponse) {
        throw new Error('Failed to get GALA price from Binance');
      }
      
      const galaPriceUsdt = Number(galaPriceResponse.price);
      const usdtNeeded = galaAmount * galaPriceUsdt;

      if (!binanceTrading) {
        throw new Error('BinanceTrading is not available - cannot execute Binance trade');
      }

      logger.info(
        {
          symbol: 'GALAUSDT',
          side: 'BUY',
          usdtAmount: usdtNeeded.toFixed(4),
          galaAmount,
          price: galaPriceUsdt,
        },
        'Executing Binance BUY order',
      );

      // Use LIMIT order with maker pricing (0.02% fee instead of 0.1%)
      // Set price slightly above market to ensure it fills as maker order
      const limitPrice = (galaPriceUsdt * 1.001).toFixed(8); // 0.1% above market to ensure fill
      const galaQuantity = galaAmount.toFixed(0); // GALA amount to buy

      const binanceOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: 'GALAUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: galaQuantity,
        price: limitPrice,
        timeInForce: 'GTC', // Good Till Canceled
      });

      logger.info(
        {
          orderId: binanceOrder.orderId,
          status: binanceOrder.status,
          executedQty: binanceOrder.executedQty,
          cummulativeQuoteQty: binanceOrder.cummulativeQuoteQty,
        },
        '✅ Binance trade executed successfully',
      );

      // Step 2: Sell GALA on GalaSwap for receiving token (GUSDC)
      const receivingToken = 'GUSDC'; // From reverse arbitrage check
      
      logger.info(
        {
          tokenIn: 'GALA|Unit|none|none',
          tokenOut: `${receivingToken}|Unit|none|none`,
          amountIn: galaAmount,
          expectedOut: opportunity.receivingTokenAmount,
        },
        'Executing reverse arbitrage: Step 2 - Selling GALA on GalaSwap',
      );

      const galaSwapResult = await galaChainRouter.requestSwap({
        offered: [
          {
            quantity: String(galaAmount),
            tokenInstance: {
              collection: 'GALA',
              category: 'Unit',
              type: 'none',
              additionalKey: 'none',
            },
          },
        ],
        wanted: [
          {
            quantity: String(opportunity.receivingTokenAmount),
            tokenInstance: {
              collection: receivingToken,
              category: 'Unit',
              type: 'none',
              additionalKey: 'none',
            },
          },
        ],
      });

      logger.info(
        {
          transactionId: galaSwapResult.transactionId,
          status: galaSwapResult.status,
          netProfit: opportunity.netProfit,
          receivingToken,
          receivingTokenAmount: opportunity.receivingTokenAmount,
        },
        '✅ Reverse arbitrage execution complete on BOTH platforms!',
      );
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          errorStack: error?.stack,
          errorType: error?.constructor?.name,
          opportunity,
          direction: 'Binance->GalaSwap',
        },
        '❌ Failed to execute reverse arbitrage trades',
      );
      throw error;
    }
  }

  /**
   * Mirror GWETH to Binance using reverse arbitrage pattern: ETH → USDT → GALA
   * Based on the user's script: Sell ETH for USDT, then buy GALA with USDT
   */
  private async mirrorGwethToBinanceReverse(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    gwethAmount: number,
  ): Promise<void> {
    try {
      logger.info(
        {
          gwethAmount,
          route: 'ETH → USDT → GALA',
        },
        '🔄 Binance Mirror: Executing ETH → USDT → GALA (reverse arbitrage pattern)',
      );

      // Step 1: Sell ETH for USDT
      const ethSymbol = 'ETH/USDT';
      const ethAmount = gwethAmount; // GWETH is 1:1 with ETH

      logger.info(
        {
          symbol: ethSymbol,
          side: 'SELL',
          ethAmount,
        },
        '📉 Step 1: Selling ETH for USDT',
      );

      // Use market order to sell ETH
      const ethOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: 'ETHUSDT',
        side: 'SELL',
        type: 'MARKET',
        quantity: String(ethAmount),
      });

      // Get USDT received from the order (cummulativeQuoteQty is the total quote asset spent/received)
      let usdtReceived = ethOrder.cummulativeQuoteQty ? Number(ethOrder.cummulativeQuoteQty) : 0;

      // Fallback: If cummulativeQuoteQty is 0 or missing, fetch balance
      if (!usdtReceived || usdtReceived === 0) {
        logger.info('⏳ Fetching live USDT balance...');
        const balances = await binanceApi.getBalances();
        const usdtBalance = balances.get('USDT');
        usdtReceived = usdtBalance ? Number(usdtBalance.free) : 0;
      }

      if (usdtReceived < 6) {
        throw new Error(`USDT amount (${usdtReceived}) too small for Binance minimum trade (need $10+)`);
      }

      logger.info(
        {
          usdtReceived: usdtReceived.toFixed(2),
          ethOrderId: ethOrder.orderId,
        },
        '✅ Step 1 complete: ETH sold for USDT',
      );

      // Step 2: Buy GALA with USDT
      const galaSymbol = 'GALA/USDT';

      logger.info(
        {
          symbol: galaSymbol,
          side: 'BUY',
          usdtAmount: usdtReceived.toFixed(2),
        },
        '📈 Step 2: Buying GALA with USDT',
      );

      // Use market order to buy GALA with USDT
      const galaOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: 'GALAUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: String(usdtReceived), // For market buy, quantity is in quote currency (USDT)
      });

      logger.info(
        {
          galaOrderId: galaOrder.orderId,
          galaReceived: galaOrder.executedQty || 'pending',
          usdtSpent: usdtReceived.toFixed(2),
        },
        '✨ Binance Mirror Successful: ETH → USDT → GALA complete',
      );
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          gwethAmount,
        },
        '⚠️ Binance Mirror Failed: ETH → USDT → GALA',
      );

      if (error?.message?.includes('-2015')) {
        logger.warn(
          {
            note: "Enable 'Spot & Margin Trading' in Binance API settings",
          },
          '👉 FIX: Binance API permissions issue',
        );
      }

      throw error;
    }
  }

  /**
   * Generic method to mirror GALA to Binance for any target token (ETH, BTC, SOL, etc.)
   * Path: GALA → USDT → Target Token
   */
  private async mirrorGalaToBinanceForToken(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    galaAmount: number,
    targetToken: string, // 'ETH', 'BTC', 'SOL', etc.
    binanceSymbol: string, // 'ETHUSDT', 'BTCUSDT', 'SOLUSDT', etc.
  ): Promise<void> {
    try {
      // Check if GALA amount meets Binance minimum notional ($10)
      const galaPrice = await binanceApi.getPrice('GALAUSDT');
      if (!galaPrice) {
        logger.warn(
          {
            galaAmount,
            targetToken,
            note: 'Cannot fetch GALA price - skipping Binance mirror',
          },
          `⚠️ Skipping Binance mirror: GALA price unavailable`,
        );
        return;
      }

      const galaPriceUsdt = Number(galaPrice.price);
      const tradeValueUsdt = galaAmount * galaPriceUsdt;
      const BINANCE_MIN_NOTIONAL = 10; // Binance minimum trade value

      if (tradeValueUsdt < BINANCE_MIN_NOTIONAL) {
        logger.warn(
          {
            galaAmount,
            galaPriceUsdt: galaPriceUsdt.toFixed(6),
            tradeValueUsdt: tradeValueUsdt.toFixed(2),
            minimumRequired: BINANCE_MIN_NOTIONAL,
            targetToken,
            note: 'Trade value below Binance minimum notional - skipping mirror to avoid NOTIONAL errors',
          },
          `⚠️ Skipping Binance mirror: Trade value too small (below $10 minimum)`,
        );
        return; // Skip Binance mirror for trades below minimum notional
      }

      logger.info(
        {
          galaAmount,
          targetToken,
          binanceSymbol,
          path: `GALA → USDT → ${targetToken}`,
          tradeValueUsdt: tradeValueUsdt.toFixed(2),
        },
        `🔄 Starting Binance mirror: GALA → USDT → ${targetToken}`,
      );

      // Step 1: Sell GALA for USDT
      const galaSymbol = 'GALA/USDT';
      logger.info(
        {
          symbol: galaSymbol,
          side: 'SELL',
          galaAmount,
        },
        '📉 Step 1: Selling GALA for USDT',
      );

      const galaOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: 'GALAUSDT',
        side: 'SELL',
        type: 'MARKET',
        quantity: String(galaAmount),
      });

      // Get USDT received
      let usdtReceived = galaOrder.cummulativeQuoteQty ? Number(galaOrder.cummulativeQuoteQty) : 0;

      if (!usdtReceived || usdtReceived === 0) {
        logger.info('⏳ Fetching live USDT balance...');
        const balances = await binanceApi.getBalances();
        const usdtBalance = balances.get('USDT');
        usdtReceived = usdtBalance ? Number(usdtBalance.free) : 0;
      }

      if (usdtReceived < 6) {
        throw new Error(`USDT amount (${usdtReceived}) too small for Binance minimum trade (need $10+)`);
      }

      logger.info(
        {
          usdtReceived: usdtReceived.toFixed(2),
          galaOrderId: galaOrder.orderId,
        },
        '✅ Step 1 complete: GALA sold for USDT',
      );

      // Step 2: Buy target token with USDT
      logger.info(
        {
          symbol: binanceSymbol,
          side: 'BUY',
          usdtAmount: usdtReceived.toFixed(2),
          targetToken,
        },
        `📈 Step 2: Buying ${targetToken} with USDT`,
      );

      const targetOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: binanceSymbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: String(usdtReceived), // For market buy, quantity is in quote currency (USDT)
      });

      logger.info(
        {
          targetOrderId: targetOrder.orderId,
          targetReceived: targetOrder.executedQty || 'pending',
          usdtSpent: usdtReceived.toFixed(2),
          targetToken,
        },
        `✨ Binance Mirror Successful: GALA → USDT → ${targetToken} complete`,
      );
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          galaAmount,
          targetToken,
        },
        `⚠️ Binance Mirror Failed: GALA → USDT → ${targetToken}`,
      );

      if (error?.message?.includes('-2015')) {
        logger.warn(
          {
            note: "Enable 'Spot & Margin Trading' in Binance API settings",
          },
          '👉 FIX: Binance API permissions issue',
        );
      }

      throw error;
    }
  }

  /**
   * Execute reverse arbitrage: GalaChain first (GALA → GWETH), then mirror on Binance
   * Based on the user's script pattern
   */
  async executeReverseArbitragePattern(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    galaChainRouter: GalaChainRouter,
    galaAmount: number,
  ): Promise<void> {
    try {
      logger.info(
        {
          galaAmount,
          pattern: 'GalaChain → Binance (reverse)',
        },
        '🚀 Starting reverse arbitrage: GALA → GWETH on GalaChain, then mirror on Binance',
      );

      // Step 1: Execute GALA → GWETH swap on GalaChain
      const galaSwapResult = await galaChainRouter.executeDirectGalaToGwethSwap(
        String(galaAmount),
        0.97, // 3% slippage tolerance
      );

      // Step 2: Success gate - only proceed if GalaChain swap succeeded
      if (!galaSwapResult.success) {
        logger.error(
          {
            transactionId: galaSwapResult.transactionId,
            message: 'GalaChain swap failed - aborting Binance mirror',
          },
          '❌ GalaSwap Leg Failed. Binance trade aborted.',
        );
        return;
      }

      logger.info(
        {
          transactionId: galaSwapResult.transactionId,
          gwethAmount: galaSwapResult.gwethAmount,
        },
        '✅ GalaSwap SUCCESS - Proceeding to Binance mirror',
      );

      // Step 3: Mirror on Binance (ETH → USDT → GALA)
      await this.mirrorGwethToBinanceReverse(
        logger,
        binanceApi,
        binanceTrading,
        Number(galaSwapResult.gwethAmount),
      );

      logger.info(
        {
          galaAmount,
          gwethAmount: galaSwapResult.gwethAmount,
        },
        '✅ Reverse arbitrage complete: GalaChain → Binance',
      );
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          galaAmount,
        },
        '❌ Reverse arbitrage sequence error',
      );
      throw error;
    }
  }

  /**
   * Mirror GALA to Binance using high-volume path: GALA → USDT → ETH
   * Based on the user's script pattern for high-volume arbitrage
   */
  private async mirrorGalaToBinanceHighVolume(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    galaAmount: number,
  ): Promise<void> {
    try {
      // Check if GALA amount meets Binance minimum notional ($10)
      const galaPrice = await binanceApi.getPrice('GALAUSDT');
      if (!galaPrice) {
        logger.warn(
          {
            galaAmount,
            note: 'Cannot fetch GALA price - skipping Binance mirror',
          },
          '⚠️ Skipping Binance mirror: GALA price unavailable',
        );
        return;
      }

      const galaPriceUsdt = Number(galaPrice.price);
      const tradeValueUsdt = galaAmount * galaPriceUsdt;
      const BINANCE_MIN_NOTIONAL = 10; // Binance minimum trade value

      if (tradeValueUsdt < BINANCE_MIN_NOTIONAL) {
        logger.warn(
          {
            galaAmount,
            galaPriceUsdt: galaPriceUsdt.toFixed(6),
            tradeValueUsdt: tradeValueUsdt.toFixed(2),
            minimumRequired: BINANCE_MIN_NOTIONAL,
            note: 'Trade value below Binance minimum notional - skipping mirror to avoid NOTIONAL errors',
          },
          '⚠️ Skipping Binance mirror: Trade value too small (below $10 minimum)',
        );
        return; // Skip Binance mirror for trades below minimum notional
      }

      logger.info(
        {
          galaAmount,
          route: 'GALA → USDT → ETH',
          tradeValueUsdt: tradeValueUsdt.toFixed(2),
        },
        '🔄 Starting High-Volume Path: GALA → USDT → ETH',
      );

      // Step 1: GALA → USDT
      const galaSymbol = 'GALA/USDT';
      
      logger.info(
        {
          symbol: galaSymbol,
          side: 'SELL',
          galaAmount,
        },
        '📉 Step 1: Selling GALA for USDT',
      );

      // Use market order to sell GALA
      const galaOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: 'GALAUSDT',
        side: 'SELL',
        type: 'MARKET',
        quantity: String(galaAmount),
      });

      // Calculate actual USDT received (after fees/fill price)
      let usdtReceived = galaOrder.cummulativeQuoteQty ? Number(galaOrder.cummulativeQuoteQty) : 0;

      // Fallback: If cummulativeQuoteQty is 0 or missing, fetch balance
      if (!usdtReceived || usdtReceived === 0) {
        logger.info('⏳ Fetching live USDT balance...');
        const balances = await binanceApi.getBalances();
        const usdtBalance = balances.get('USDT');
        usdtReceived = usdtBalance ? Number(usdtBalance.free) : 0;
      }

      logger.info(
        {
          usdtReceived: usdtReceived.toFixed(2),
          galaOrderId: galaOrder.orderId,
        },
        '✅ Received USDT from GALA sale',
      );

      if (usdtReceived < 6) {
        throw new Error(`USDT amount (${usdtReceived}) too small for Binance minimum trade (need $10+)`);
      }

      // Step 2: USDT → ETH
      const ethSymbol = 'ETH/USDT';
      
      logger.info(
        {
          symbol: ethSymbol,
          side: 'BUY',
          usdtAmount: usdtReceived.toFixed(2),
        },
        '📈 Step 2: Swapping USDT back to ETH',
      );

      // Use market buy by quote amount (USDT) - more robust way
      const ethOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: 'ETHUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: String(usdtReceived), // For market buy, quantity is in quote currency (USDT)
      });

      logger.info(
        {
          ethOrderId: ethOrder.orderId,
          ethReceived: ethOrder.executedQty || 'pending',
          usdtSpent: usdtReceived.toFixed(2),
        },
        '✨ Binance Mirror Successful: GALA → USDT → ETH complete',
      );
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          galaAmount,
        },
        '⚠️ Binance Mirror Failed: GALA → USDT → ETH',
      );

      if (error?.message?.includes('-2015')) {
        logger.warn(
          {
            note: "Enable 'Spot & Margin Trading' in Binance API settings",
          },
          '👉 FIX: Binance API permissions issue',
        );
      }

      throw error;
    }
  }

  /**
   * ⚠️ DISABLED: Execute direct GALA ↔ GWETH swaps before arbitrage checks
   * 
   * PROBLEM: This method was executing BOTH directions unconditionally:
   * 1. First: GALA → GWETH (if galaAmount >= 1000)
   * 2. Then: GWETH → GALA (if gwethAmount >= 0.0001)
   * 
   * This caused the bot to reverse trades immediately on the same platform,
   * which defeats the purpose of arbitrage.
   * 
   * SOLUTION: Disabled. Use arbitrage opportunity checks instead, which:
   * - Only execute when there's a profitable opportunity
   * - Only execute ONE direction per tick
   * - Don't reverse trades on the same platform
   */
  // private async executeDirectGalaGwethSwaps(
  //   logger: ILogger,
  //   galaChainRouter: GalaChainRouter,
  //   binanceApi: IBinanceApi,
  //   binanceTrading: BinanceTrading,
  //   ownBalances: readonly Readonly<ITokenBalance>[],
  // ): Promise<void> {
  //   // METHOD DISABLED - was causing trade reversals
  // }

  /**
   * Execute GWETH → GALA arbitrage: GalaChain first (GWETH → GALA), then mirror on Binance
   * Based on the user's script pattern for GWETH arbitrage
   */
  async executeGwethArbitragePattern(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    galaChainRouter: GalaChainRouter,
    gwethAmount: number,
  ): Promise<void> {
    try {
      logger.info(
        {
          gwethAmount,
          pattern: 'GalaChain → Binance (GWETH arbitrage)',
        },
        '🚀 Starting GWETH arbitrage: GWETH → GALA on GalaChain, then mirror on Binance',
      );

      // Step 1: Execute GWETH → GALA swap on GalaChain
      const galaSwapResult = await galaChainRouter.executeDirectGwethToGalaSwap(
        String(gwethAmount),
        0.95, // 5% slippage tolerance (as per user's script)
      );

      // Step 2: Success gate - only proceed if GalaChain swap succeeded
      if (!galaSwapResult.success) {
        logger.error(
          {
            transactionId: galaSwapResult.transactionId,
            message: 'GalaChain swap failed - aborting Binance mirror',
          },
          '❌ GalaSwap Transaction Failed. Binance trade aborted.',
        );
        return;
      }

      const receivedGala = Number(galaSwapResult.galaAmount);

      logger.info(
        {
          transactionId: galaSwapResult.transactionId,
          galaAmount: receivedGala,
        },
        '✨ GalaSwap Success! Received GALA - Proceeding to Binance mirror',
      );

      // Step 3: Mirror on Binance (GALA → USDT → ETH) - High-volume path
      await this.mirrorGalaToBinanceHighVolume(
        logger,
        binanceApi,
        binanceTrading,
        receivedGala,
      );

      logger.info(
        {
          gwethAmount,
          galaAmount: receivedGala,
        },
        '✅ GWETH arbitrage complete: GalaChain → Binance',
      );
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          gwethAmount,
        },
        '❌ Error in Sequence: GWETH arbitrage failed',
      );
      throw error;
    }
  }

}

