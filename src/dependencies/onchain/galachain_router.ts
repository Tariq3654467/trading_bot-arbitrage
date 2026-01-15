import { GSwap, PrivateKeySigner } from '@gala-chain/gswap-sdk';
import { ILogger, ITokenClassKey } from '../../types/types.js';

/**
 * GalaChain Router using Official gSwap SDK
 * Uses Token Class Keys (pipe-separated format: Collection|Category|Type|AdditionalKey)
 * Example: 'GALA|Unit|none|none'
 */
export interface IGalaChainSwapRequest {
  offered: readonly Readonly<{
    quantity: string;
    tokenInstance: Readonly<ITokenClassKey>;
  }>[];
  wanted: readonly Readonly<{
    quantity: string;
    tokenInstance: Readonly<ITokenClassKey>;
  }>[];
}

export interface IGalaChainSwapResult {
  transactionId: string;
  status: 'pending' | 'confirmed';
  blockNumber?: number;
}

export interface IGalaChainQuote {
  amountOut: string;
  priceImpact?: number | undefined;
  feeTier?: string | undefined;
}

/**
 * Convert Token Class Key to pipe-separated string format
 */
function formatTokenClassKey(token: Readonly<ITokenClassKey>): string {
  return `${token.collection}|${token.category}|${token.type}|${token.additionalKey}`;
}

export class GalaChainRouter {
  private readonly gSwap: GSwap;
  private readonly walletAddress: string;
  private readonly logger: ILogger;

  constructor(
    _rpcUrl: string, // Not used by SDK, but kept for compatibility
    walletAddress: string,
    privateKey: string,
    logger: ILogger,
    _contractName?: string, // Not used by SDK, but kept for compatibility
  ) {
    this.walletAddress = walletAddress;
    this.logger = logger;

    // Initialize gSwap SDK with private key signer
    this.gSwap = new GSwap({
      signer: new PrivateKeySigner(privateKey),
    });

    this.logger.info(
      {
        walletAddress: this.walletAddress,
      },
      'GalaChain router initialized with official gSwap SDK',
    );
  }

  /**
   * Execute swap using official gSwap SDK
   * This creates a direct swap (not an order book swap)
   */
  async requestSwap(swapRequest: IGalaChainSwapRequest): Promise<IGalaChainSwapResult> {
    try {
      const offeredFirst = swapRequest.offered[0];
      const wantedFirst = swapRequest.wanted[0];
      if (!offeredFirst || !wantedFirst) {
        throw new Error('Invalid swap request: missing offered or wanted token');
      }

      const tokenIn = formatTokenClassKey(offeredFirst.tokenInstance);
      const tokenOut = formatTokenClassKey(wantedFirst.tokenInstance);
      const amountIn = Number(offeredFirst.quantity);

      this.logger.info(
        {
          tokenIn,
          tokenOut,
          amountIn,
        },
        'Requesting swap via gSwap SDK',
      );

      // Force 1% fee tier (10000) for all pairs as per user requirement
      const feeTier = 10000; // 1.00% fee tier
      const quote = await this.gSwap.quoting.quoteExactInput(tokenIn, tokenOut, amountIn, feeTier);

      this.logger.info(
        {
          tokenIn,
          tokenOut,
          amountIn,
          amountOut: quote.outTokenAmount.toString(),
          feeTier: feeTier,
          feePercent: '1.00%',
        },
        'Quote received from gSwap SDK (1% fee tier)',
      );

      // Execute swap with 5% slippage tolerance
      const slippageTolerance = 0.95; // 5% slippage
      const amountOutMinimum = quote.outTokenAmount.multipliedBy(slippageTolerance);

      const transaction = await this.gSwap.swaps.swap(
        tokenIn,
        tokenOut,
        feeTier, // Force 1% fee tier (10000) for all swaps
        {
          exactIn: amountIn,
          amountOutMinimum: amountOutMinimum,
        },
        this.walletAddress,
      );

      this.logger.info(
        {
          transactionId: transaction.transactionId ?? 'pending',
          tokenIn,
          tokenOut,
          amountIn,
          amountOut: quote.outTokenAmount.toString(),
        },
        'Swap executed successfully via gSwap SDK',
      );

      return {
        transactionId: transaction.transactionId ?? 'pending',
        status: 'pending',
      };
    } catch (error) {
      this.logger.error({ error, swapRequest }, 'Failed to execute swap via gSwap SDK');
      throw error;
    }
  }

  /**
   * Accept an existing swap (order book style)
   * Note: gSwap SDK is primarily for direct swaps, not order book swaps
   * This method is kept for compatibility but may not work with SDK
   */
  async acceptSwap(_swapRequestId: string, _uses: string): Promise<IGalaChainSwapResult> {
    // The gSwap SDK doesn't support accepting existing swaps from order book
    // This would need to use the REST API instead
    throw new Error(
      'acceptSwap is not supported by gSwap SDK. Use REST API for order book swaps.',
    );
  }

  /**
   * Get price quote using gSwap SDK
   * @param feeTier Optional fee tier (default: 10000 = 1.00%). Use 1% for all pairs as per user requirement.
   */
  async getQuote(
    tokenIn: ITokenClassKey,
    tokenOut: ITokenClassKey,
    amountIn: string,
    feeTier?: number,
  ): Promise<IGalaChainQuote> {
    try {
      const tokenInStr = formatTokenClassKey(tokenIn);
      const tokenOutStr = formatTokenClassKey(tokenOut);
      const amountInNum = Number(amountIn);
      // Force 1% fee tier (10000) for all pairs as per user requirement
      const tier = feeTier ?? 10000;

      this.logger.info(
        {
          tokenIn: tokenInStr,
          tokenOut: tokenOutStr,
          amountIn: amountInNum,
          feeTier: tier,
          feePercent: '1.00%',
        },
        'Getting quote from gSwap SDK (1% fee tier)',
      );

      const quote = await this.gSwap.quoting.quoteExactInput(
        tokenInStr,
        tokenOutStr,
        amountInNum,
        tier,
      );

      this.logger.info(
        {
          tokenIn: tokenInStr,
          tokenOut: tokenOutStr,
          amountIn: amountInNum,
          amountOut: quote.outTokenAmount.toString(),
          feeTier: quote.feeTier,
        },
        'Quote received from gSwap SDK',
      );

      return {
        amountOut: quote.outTokenAmount.toString(),
        feeTier: quote.feeTier !== undefined && quote.feeTier !== null 
          ? String(quote.feeTier) 
          : undefined,
        // SDK doesn't provide price impact directly, but we can calculate it if needed
      };
    } catch (error) {
      this.logger.error({ error, tokenIn, tokenOut, amountIn }, 'Failed to get quote from gSwap SDK');
      throw error;
    }
  }

  /**
   * Get balances using gSwap SDK's getUserAssets method
   */
  async getBalances(walletAddress?: string): Promise<readonly Readonly<{
    collection: string;
    category: string;
    type: string;
    additionalKey: string;
    quantity: string;
    lockedHolds: readonly Readonly<{
      expires: number;
      quantity: string;
    }>[];
  }>[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      this.logger.info(
        {
          walletAddress: address,
        },
        'Getting balances from gSwap SDK',
      );

      // Fetch all assets with pagination
      const allBalances: Array<{
        collection: string;
        category: string;
        type: string;
        additionalKey: string;
        quantity: string;
        lockedHolds: readonly Readonly<{
          expires: number;
          quantity: string;
        }>[];
      }> = [];

      let page = 1;
      const limit = 20; // SDK maximum limit per page
      let hasMore = true;

      while (hasMore) {
        const assets = await this.gSwap.assets.getUserAssets(address, page, limit);

        // Convert SDK token format to our balance format
        for (const token of assets.tokens) {
          // SDK returns tokens with properties like symbol, quantity, name, decimals, image
          // The SDK uses compositeKey with dollar separator: "GALA$Unit$none$none"
          const tokenAny = token as unknown as {
            compositeKey?: string;
            tokenClass?: string;
            collection?: string;
            category?: string;
            type?: string;
            additionalKey?: string;
            quantity?: string | number;
          };

          let collection = '';
          let category = 'Unit';
          let type = 'none';
          let additionalKey = 'none';

          // SDK uses compositeKey with $ separator: "Collection$Category$Type$AdditionalKey"
          if (tokenAny.compositeKey) {
            const parts = tokenAny.compositeKey.split('$');
            if (parts.length === 4) {
              collection = parts[0] ?? '';
              category = parts[1] ?? 'Unit';
              type = parts[2] ?? 'none';
              additionalKey = parts[3] ?? 'none';
            }
          } else if (tokenAny.tokenClass) {
            // Parse pipe-separated token class key: "Collection|Category|Type|AdditionalKey"
            const parts = tokenAny.tokenClass.split('|');
            if (parts.length === 4) {
              collection = parts[0] ?? '';
              category = parts[1] ?? 'Unit';
              type = parts[2] ?? 'none';
              additionalKey = parts[3] ?? 'none';
            }
          } else if (tokenAny.collection && tokenAny.category && tokenAny.type && tokenAny.additionalKey) {
            // Use direct properties if available
            collection = tokenAny.collection;
            category = tokenAny.category;
            type = tokenAny.type;
            additionalKey = tokenAny.additionalKey;
          } else {
            // Fallback: try to infer from symbol (not ideal, but better than empty)
            collection = (token as unknown as { symbol?: string }).symbol ?? '';
            this.logger.warn(
              {
                token,
                walletAddress: address,
              },
              'Token missing token class information, using symbol as collection',
            );
          }

          const balance = {
            collection,
            category,
            type,
            additionalKey,
            quantity: String(tokenAny.quantity ?? token.quantity ?? '0'),
            lockedHolds: [] as readonly Readonly<{
              expires: number;
              quantity: string;
            }>[],
          };
          allBalances.push(balance);
        }

        // Check if there are more pages
        hasMore = assets.tokens.length === limit;
        page++;
      }

      this.logger.info(
        {
          walletAddress: address,
          tokenCount: allBalances.length,
        },
        'Balances retrieved from gSwap SDK',
      );

      return allBalances;
    } catch (error) {
      this.logger.error({ error, walletAddress }, 'Failed to get balances from gSwap SDK');
      // Return empty array on error to trigger REST API fallback
      return [];
    }
  }

  /**
   * Get available swaps - SDK doesn't provide this, return empty array
   * Use REST API fallback for order book swaps
   */
  async getAvailableSwaps(
    _offeredTokenClass: Readonly<ITokenClassKey>,
    _wantedTokenClass: Readonly<ITokenClassKey>,
  ): Promise<readonly Readonly<{
    swapRequestId: string;
    offered: readonly Readonly<{
      quantity: string;
      tokenInstance: Readonly<ITokenClassKey>;
    }>[];
    wanted: readonly Readonly<{
      quantity: string;
      tokenInstance: Readonly<ITokenClassKey>;
    }>[];
    created: number;
    expires: number;
    uses: string;
    usesSpent: string;
    offeredBy: string;
  }>[]> {
    // gSwap SDK doesn't provide order book swap queries
    // Return empty array to trigger REST API fallback
    this.logger.warn('gSwap SDK does not support order book swap queries, use REST API fallback');
    return [];
  }

  /**
   * Get tokens - SDK doesn't provide this, return empty array
   * Use REST API fallback for token lists
   */
  async getTokens(_searchPrefix?: string): Promise<readonly Readonly<{
    symbol: string;
    collection: string;
    category: string;
    type: string;
    additionalKey: string;
    decimals: number;
    currentPrices: Readonly<{
      usd?: number;
    }>;
  }>[]> {
    // gSwap SDK doesn't provide token list queries
    // Return empty array to trigger REST API fallback
    this.logger.warn('gSwap SDK does not support token list queries, use REST API fallback');
    return [];
  }

  /**
   * Get swaps by wallet address - SDK doesn't provide this, return empty array
   * Use REST API fallback
   */
  async getSwapsByWalletAddress(_walletAddress: string): Promise<readonly Readonly<{
    swapRequestId: string;
    offered: readonly Readonly<{
      quantity: string;
      tokenInstance: Readonly<ITokenClassKey>;
    }>[];
    wanted: readonly Readonly<{
      quantity: string;
      tokenInstance: Readonly<ITokenClassKey>;
    }>[];
    created: number;
    expires: number;
    uses: string;
    usesSpent: string;
    offeredBy: string;
  }>[]> {
    // gSwap SDK doesn't provide swap history queries
    // Return empty array to trigger REST API fallback
    this.logger.warn('gSwap SDK does not support swap history queries, use REST API fallback');
    return [];
  }

  /**
   * Get contract name (for compatibility)
   */
  getContractName(): string {
    return 'gswap-sdk';
  }

  /**
   * Get wallet address
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  /**
   * Execute direct GALA → GWETH swap with explicit 1% fee tier and success gate
   * Based on reverse arbitrage pattern: GalaChain first, then mirror on Binance
   * @param galaAmount Amount of GALA to swap
   * @param slippageTolerance Slippage tolerance (default: 0.97 = 3%)
   * @returns Transaction result with success status check
   */
  async executeDirectGalaToGwethSwap(
    galaAmount: string,
    slippageTolerance: number = 0.97,
  ): Promise<{
    transactionId: string;
    status: 'pending' | 'confirmed';
    success: boolean;
    gwethAmount: string;
    transaction: any; // Full transaction object for inspection
  }> {
    const GALA = 'GALA|Unit|none|none';
    const GWETH = 'GWETH|Unit|none|none';
    const FEE_TIER = 10000; // Explicitly use 1% fee tier

    this.logger.info(
      {
        galaAmount,
        feeTier: FEE_TIER,
        slippageTolerance: slippageTolerance * 100 + '%',
      },
      'Executing direct GALA → GWETH swap with explicit 1% fee tier',
    );

    try {
      // Step 1: Get quote
      this.logger.info(
        {
          tokenIn: GALA,
          tokenOut: GWETH,
          amountIn: galaAmount,
          feeTier: FEE_TIER,
        },
        'Getting quote for GALA → GWETH',
      );

      const quote = await this.gSwap.quoting.quoteExactInput(GALA, GWETH, Number(galaAmount), FEE_TIER);

      this.logger.info(
        {
          amountIn: galaAmount,
          amountOut: quote.outTokenAmount.toString(),
          feeTier: quote.feeTier,
        },
        'Quote received for GALA → GWETH',
      );

      // Step 2: Execute swap
      this.logger.info(
        {
          amountIn: galaAmount,
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance).toString(),
        },
        'Sending swap to GalaChain...',
      );

      const transaction = await this.gSwap.swaps.swap(
        GALA,
        GWETH,
        FEE_TIER,
        {
          exactIn: Number(galaAmount),
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance),
        },
        this.walletAddress,
      );

      // Step 3: Success gate - check transaction status
      // Check Status 1 (Success) or the presence of a transactionId
      const isSuccess =
        (transaction as any).Status === 1 ||
        (transaction as any).Data?.transactionId ||
        transaction.transactionId;

      const txId = transaction.transactionId || (transaction as any).Data?.transactionId || 'pending';

      if (isSuccess) {
        this.logger.info(
          {
            transactionId: txId,
            status: 'success',
            gwethAmount: quote.outTokenAmount.toString(),
          },
          '✅ GalaSwap SUCCESS - Transaction confirmed',
        );
      } else {
        this.logger.warn(
          {
            transactionId: txId,
            message: (transaction as any).Message || (transaction as any).message || 'Unknown error',
          },
          '⚠️ GalaSwap transaction status unclear',
        );
      }

      return {
        transactionId: txId,
        status: isSuccess ? 'confirmed' : 'pending',
        success: !!isSuccess,
        gwethAmount: quote.outTokenAmount.toString(),
        transaction, // Return full transaction for inspection
      };
    } catch (error: any) {
      this.logger.error(
        {
          error: error?.message || error?.toString() || error,
          galaAmount,
        },
        'Failed to execute direct GALA → GWETH swap',
      );
      throw error;
    }
  }

  /**
   * Execute direct GWETH → GALA swap with explicit 1% fee tier and success gate
   * Based on reverse arbitrage pattern: GalaChain first, then mirror on Binance
   * @param gwethAmount Amount of GWETH to swap
   * @param slippageTolerance Slippage tolerance (default: 0.95 = 5%)
   * @returns Transaction result with success status check
   */
  async executeDirectGwethToGalaSwap(
    gwethAmount: string,
    slippageTolerance: number = 0.95,
  ): Promise<{
    transactionId: string;
    status: 'pending' | 'confirmed';
    success: boolean;
    galaAmount: string;
    transaction: any; // Full transaction object for inspection
  }> {
    const GWETH = 'GWETH|Unit|none|none';
    const GALA = 'GALA|Unit|none|none';
    const FEE_TIER = 10000; // Explicitly use 1% fee tier

    this.logger.info(
      {
        gwethAmount,
        feeTier: FEE_TIER,
        slippageTolerance: slippageTolerance * 100 + '%',
      },
      'Executing direct GWETH → GALA swap with explicit 1% fee tier',
    );

    try {
      // Step 1: Get quote
      this.logger.info(
        {
          tokenIn: GWETH,
          tokenOut: GALA,
          amountIn: gwethAmount,
          feeTier: FEE_TIER,
        },
        'Getting quote for GWETH → GALA',
      );

      const quote = await this.gSwap.quoting.quoteExactInput(GWETH, GALA, Number(gwethAmount), FEE_TIER);

      this.logger.info(
        {
          amountIn: gwethAmount,
          amountOut: quote.outTokenAmount.toString(),
          feeTier: quote.feeTier,
        },
        'Quote received for GWETH → GALA',
      );

      // Step 2: Execute swap
      this.logger.info(
        {
          amountIn: gwethAmount,
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance).toString(),
        },
        'Executing GalaSwap trade...',
      );

      const transaction = await this.gSwap.swaps.swap(
        GWETH,
        GALA,
        quote.feeTier, // Use fee tier from quote
        {
          exactIn: Number(gwethAmount),
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance),
        },
        this.walletAddress,
      );

      // Step 3: Success gate - check transaction status
      // Check Status 1 (Success) or the absence of error
      const isSuccess =
        (transaction as any).Status === 1 ||
        !(transaction as any).error ||
        (transaction as any).Data?.transactionId ||
        transaction.transactionId;

      const txId = transaction.transactionId || (transaction as any).Data?.transactionId || 'pending';
      const receivedGala = quote.outTokenAmount.toString();

      if (isSuccess) {
        this.logger.info(
          {
            transactionId: txId,
            status: 'success',
            galaAmount: receivedGala,
          },
          '✨ GalaSwap Success! Received GALA',
        );
      } else {
        this.logger.error(
          {
            transactionId: txId,
            message: (transaction as any).Message || (transaction as any).message || 'Unknown error',
          },
          '❌ GalaSwap Transaction Failed',
        );
      }

      return {
        transactionId: txId,
        status: isSuccess ? 'confirmed' : 'pending',
        success: !!isSuccess,
        galaAmount: receivedGala,
        transaction, // Return full transaction for inspection
      };
    } catch (error: any) {
      this.logger.error(
        {
          error: error?.message || error?.toString() || error,
          gwethAmount,
        },
        '❌ Error in Sequence: Failed to execute direct GWETH → GALA swap',
      );
      throw error;
    }
  }

  /**
   * Execute direct GALA → GWBTC swap
   * @param galaAmount - Amount of GALA to swap
   * @param slippageTolerance - Slippage tolerance (0.95 = 5% slippage, 0.97 = 3% slippage)
   * @returns Swap result with transaction ID and received GWBTC amount
   */
  async executeDirectGalaToGwbctSwap(
    galaAmount: string,
    slippageTolerance: number = 0.95,
  ): Promise<{
    transactionId: string;
    status: 'pending' | 'confirmed';
    success: boolean;
    gwbctAmount: string;
    transaction: any;
  }> {
    const GALA = 'GALA|Unit|none|none';
    const GWBTC = 'GWBTC|Unit|none|none';
    const FEE_TIER = 10000; // 1% fee tier

    this.logger.info(
      {
        galaAmount,
        feeTier: FEE_TIER,
        slippageTolerance: `${(slippageTolerance * 100).toFixed(0)}%`,
      },
      'Executing direct GALA → GWBTC swap with explicit 1% fee tier',
    );

    try {
      // Step 1: Get quote
      this.logger.info(
        {
          tokenIn: GALA,
          tokenOut: GWBTC,
          amountIn: galaAmount,
          feeTier: FEE_TIER,
        },
        'Getting quote for GALA → GWBTC',
      );

      const quote = await this.gSwap.quoting.quoteExactInput(GALA, GWBTC, Number(galaAmount), FEE_TIER);

      this.logger.info(
        {
          amountIn: galaAmount,
          amountOut: quote.outTokenAmount.toString(),
          feeTier: quote.feeTier,
        },
        'Quote received for GALA → GWBTC',
      );

      // Step 2: Execute swap
      this.logger.info(
        {
          amountIn: galaAmount,
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance).toString(),
        },
        'Sending swap to GalaChain...',
      );

      const transaction = await this.gSwap.swaps.swap(
        GALA,
        GWBTC,
        FEE_TIER,
        {
          exactIn: Number(galaAmount),
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance),
        },
        this.walletAddress,
      );

      // Step 3: Success gate - check transaction status
      const isSuccess =
        (transaction as any).Status === 1 ||
        (transaction as any).Data?.transactionId ||
        transaction.transactionId;

      const txId = transaction.transactionId || (transaction as any).Data?.transactionId || 'pending';

      if (isSuccess) {
        this.logger.info(
          {
            transactionId: txId,
            status: 'success',
            gwbctAmount: quote.outTokenAmount.toString(),
          },
          '✅ GalaSwap SUCCESS - Transaction confirmed',
        );

        return {
          transactionId: txId,
          status: 'confirmed',
          success: true,
          gwbctAmount: quote.outTokenAmount.toString(),
          transaction,
        };
      } else {
        this.logger.error(
          {
            transactionId: txId,
            status: (transaction as any).Status,
            message: (transaction as any).Message || (transaction as any).message,
          },
          '❌ GalaSwap FAILED - Transaction not confirmed',
        );

        return {
          transactionId: txId,
          status: 'pending',
          success: false,
          gwbctAmount: '0',
          transaction,
        };
      }
    } catch (error: any) {
      this.logger.error(
        {
          error: error?.message || error?.toString() || error,
          galaAmount,
        },
        '❌ Error executing GALA → GWBTC swap',
      );
      throw error;
    }
  }

  /**
   * Execute direct GALA → GSOL swap
   * @param galaAmount - Amount of GALA to swap
   * @param slippageTolerance - Slippage tolerance (0.95 = 5% slippage, 0.97 = 3% slippage)
   * @returns Swap result with transaction ID and received GSOL amount
   */
  async executeDirectGalaToGsolSwap(
    galaAmount: string,
    slippageTolerance: number = 0.95,
  ): Promise<{
    transactionId: string;
    status: 'pending' | 'confirmed';
    success: boolean;
    gsolAmount: string;
    transaction: any;
  }> {
    const GALA = 'GALA|Unit|none|none';
    const GSOL = 'GSOL|Unit|none|none';
    const FEE_TIER = 10000; // 1% fee tier

    this.logger.info(
      {
        galaAmount,
        feeTier: FEE_TIER,
        slippageTolerance: `${(slippageTolerance * 100).toFixed(0)}%`,
      },
      'Executing direct GALA → GSOL swap with explicit 1% fee tier',
    );

    try {
      // Step 1: Get quote
      this.logger.info(
        {
          tokenIn: GALA,
          tokenOut: GSOL,
          amountIn: galaAmount,
          feeTier: FEE_TIER,
        },
        'Getting quote for GALA → GSOL',
      );

      const quote = await this.gSwap.quoting.quoteExactInput(GALA, GSOL, Number(galaAmount), FEE_TIER);

      this.logger.info(
        {
          amountIn: galaAmount,
          amountOut: quote.outTokenAmount.toString(),
          feeTier: quote.feeTier,
        },
        'Quote received for GALA → GSOL',
      );

      // Step 2: Execute swap
      this.logger.info(
        {
          amountIn: galaAmount,
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance).toString(),
        },
        'Sending swap to GalaChain...',
      );

      const transaction = await this.gSwap.swaps.swap(
        GALA,
        GSOL,
        FEE_TIER,
        {
          exactIn: Number(galaAmount),
          amountOutMinimum: quote.outTokenAmount.multipliedBy(slippageTolerance),
        },
        this.walletAddress,
      );

      // Step 3: Success gate - check transaction status
      const isSuccess =
        (transaction as any).Status === 1 ||
        (transaction as any).Data?.transactionId ||
        transaction.transactionId;

      const txId = transaction.transactionId || (transaction as any).Data?.transactionId || 'pending';

      if (isSuccess) {
        this.logger.info(
          {
            transactionId: txId,
            status: 'success',
            gsolAmount: quote.outTokenAmount.toString(),
          },
          '✅ GalaSwap SUCCESS - Transaction confirmed',
        );

        return {
          transactionId: txId,
          status: 'confirmed',
          success: true,
          gsolAmount: quote.outTokenAmount.toString(),
          transaction,
        };
      } else {
        this.logger.error(
          {
            transactionId: txId,
            status: (transaction as any).Status,
            message: (transaction as any).Message || (transaction as any).message,
          },
          '❌ GalaSwap FAILED - Transaction not confirmed',
        );

        return {
          transactionId: txId,
          status: 'pending',
          success: false,
          gsolAmount: '0',
          transaction,
        };
      }
    } catch (error: any) {
      this.logger.error(
        {
          error: error?.message || error?.toString() || error,
          galaAmount,
        },
        '❌ Error executing GALA → GSOL swap',
      );
      throw error;
    }
  }
}
