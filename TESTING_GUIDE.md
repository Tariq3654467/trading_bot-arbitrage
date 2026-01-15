# Testing Guide: How to Make the Bot Execute Trades

This guide shows you how to configure the bot to execute trades for testing purposes.

## ⚠️ IMPORTANT: Testing vs Production

**For Testing:**
- Lower profit thresholds
- Allow loss trades
- Smaller minimum amounts
- Faster check intervals

**For Production:**
- Use realistic profit thresholds
- Only execute profitable trades
- Proper minimum amounts
- Normal check intervals

---

## Quick Test Configuration

To enable test mode, modify these settings in `src/strategies/arbitrage/arbitrage_strategy.ts`:

### 1. Lower Minimum Profit Threshold

```typescript
// Change from:
private readonly MIN_PROFIT_GALA: number = 0.5;

// To (for testing - allows any profit):
private readonly MIN_PROFIT_GALA: number = -10; // Negative = allow small losses for testing
```

### 2. Enable Loss Trades (for testing)

```typescript
// Change from:
private readonly ALLOW_LOSS_TRADES: boolean = false;

// To:
private readonly ALLOW_LOSS_TRADES: boolean = true; // ⚠️ TESTING ONLY
```

### 3. Lower Minimum Trade Amount

```typescript
// Change from:
private readonly MIN_GALA_AMOUNT: number = 500;

// To (for testing with smaller balances):
private readonly MIN_GALA_AMOUNT: number = 100; // Or even 50 for very small tests
```

### 4. Add Smaller Trade Sizes

```typescript
// Change from:
private readonly TRADE_SIZE_OPTIONS: number[] = [500, 1000, 2000, 3000, 4000, 5000];

// To (for testing):
private readonly TRADE_SIZE_OPTIONS: number[] = [100, 200, 500, 1000, 2000]; // Smaller sizes first
```

### 5. Faster Check Interval (optional)

```typescript
// Change from:
private readonly ARBITRAGE_CHECK_INTERVAL: number = 60000; // 60 seconds

// To (for faster testing):
private readonly ARBITRAGE_CHECK_INTERVAL: number = 10000; // 10 seconds
```

---

## Complete Test Configuration Example

Here's a complete test configuration you can use:

```typescript
export class ArbitrageStrategy implements ISwapStrategy {
  // TEST MODE SETTINGS ⚠️
  private readonly GALA_AMOUNT: number = 5000;
  private readonly MIN_PROFIT_GALA: number = -10; // ⚠️ TESTING: Allow small losses
  private readonly MAX_PROFIT_GALA: number = 30;
  private readonly ALLOW_LOSS_TRADES: boolean = true; // ⚠️ TESTING: Execute even at loss
  private readonly GAS_FEE_GALA: number = 0.2;
  private readonly MIN_GALA_AMOUNT: number = 100; // ⚠️ TESTING: Lower minimum
  private readonly TRADE_SIZE_OPTIONS: number[] = [100, 200, 500, 1000, 2000]; // ⚠️ TESTING: Smaller sizes
  private readonly ARBITRAGE_CHECK_INTERVAL: number = 10000; // ⚠️ TESTING: 10 seconds
  // ... rest of config
}
```

---

## Prerequisites for Testing

### 1. **Sufficient Balances**

You need:
- **GALA**: At least 100-500 GALA on GalaChain
- **GWETH**: At least 0.001-0.01 GWETH (if testing GWETH swaps)
- **USDT on Binance**: At least $10-20 USDT (for Binance mirror trades)
- **GALA on Binance**: Some GALA for reverse arbitrage

### 2. **API Keys Configured**

Make sure you have:
- ✅ `GALA_PRIVATE_KEY` - Your GalaChain private key
- ✅ `GALA_WALLET_ADDRESS` - Your GalaChain wallet address
- ✅ `BINANCE_API_KEY` - Binance API key
- ✅ `BINANCE_SECRET` - Binance API secret
- ✅ Binance API permissions: **"Enable Spot & Margin Trading"**

### 3. **Network Access**

- ✅ GalaChain API accessible
- ✅ Binance API accessible
- ✅ MongoDB connection (if using)

---

## Testing Different Trade Types

### Test 1: GALA → GWETH → Binance

**What it does:**
1. Swaps GALA → GWETH on GalaChain
2. Mirrors on Binance: ETH → USDT → GALA

**Requirements:**
- At least 100-500 GALA on GalaChain
- At least $10 USDT on Binance

**Expected logs:**
```
🚀 Starting arbitrage execution on BOTH platforms
Executing GalaSwap trade: Selling GALA for GWETH
✅ GalaSwap trade executed successfully
🔄 Binance Mirror: Executing ETH → USDT → GALA
✨ Binance Mirror Successful: ETH → USDT → GALA complete
```

### Test 2: GWETH → GALA → Binance

**What it does:**
1. Swaps GWETH → GALA on GalaChain (direct swap)
2. Mirrors on Binance: GALA → USDT → ETH

**Requirements:**
- At least 0.001-0.01 GWETH on GalaChain
- At least $10 USDT on Binance

**Expected logs:**
```
Executing GalaSwap trade: GWETH → GALA (direct swap with high-volume Binance mirror)
✨ GalaSwap Success! Received GALA
🔄 Starting High-Volume Path: GALA → USDT → ETH
✨ Binance Mirror Successful: GALA → USDT → ETH complete
```

### Test 3: GALA → GUSDC → Binance

**What it does:**
1. Swaps GALA → GUSDC on GalaChain
2. Buys GALA on Binance with USDT

**Requirements:**
- At least 100-500 GALA on GalaChain
- At least $10 USDT on Binance

**Expected logs:**
```
Executing GalaSwap trade: Selling GALA for GUSDC
✅ GalaSwap trade executed successfully
Executing Binance trade: Buying GALA with USDT (GALAUSDT pair)
✅ Forward arbitrage execution complete on BOTH platforms!
```

---

## How to Verify Trades Executed

### 1. **Check Logs**

Look for these log messages:
- ✅ `"✅ GalaSwap trade executed successfully"`
- ✅ `"✨ GalaSwap Success! Received GALA"`
- ✅ `"✨ Binance Mirror Successful"`
- ✅ `"✅ Forward arbitrage execution complete"`

### 2. **Check Wallet Balances**

**GalaChain:**
- Check your GALA balance changed
- Check your GWETH/GUSDC balance changed
- Visit: https://galascan.gala.com/wallet/YOUR_WALLET_ADDRESS

**Binance:**
- Check your USDT balance changed
- Check your GALA/ETH balance changed
- Check your Binance order history

### 3. **Check Transaction IDs**

Look for transaction IDs in logs:
```
transactionId: "abc123..."
```

Note: The SDK's `transactionId` is a UUID, not a blockchain hash. The actual blockchain transaction may be in the full transaction object.

### 4. **Check MongoDB (if using)**

If you're storing trades in MongoDB, check the database for:
- Created swaps
- Accepted swaps
- Trade history

---

## Troubleshooting

### Issue: "No profitable opportunities found"

**Solutions:**
1. ✅ Lower `MIN_PROFIT_GALA` to negative value
2. ✅ Enable `ALLOW_LOSS_TRADES`
3. ✅ Check that you have sufficient balances
4. ✅ Check that Binance API is working
5. ✅ Check that GalaChain API is accessible

### Issue: "Quote failed - skipping pair"

**Solutions:**
1. ✅ Try smaller trade sizes
2. ✅ Check pool liquidity (GWETH pools may have low liquidity)
3. ✅ Try alternative pairs (GUSDC/GUSDT instead of GWETH)
4. ✅ Wait a few minutes and try again

### Issue: "Binance API permissions issue"

**Solutions:**
1. ✅ Enable "Spot & Margin Trading" in Binance API settings
2. ✅ Check API key permissions
3. ✅ Verify IP whitelist (if enabled)

### Issue: "Insufficient balance"

**Solutions:**
1. ✅ Lower `MIN_GALA_AMOUNT`
2. ✅ Use smaller `TRADE_SIZE_OPTIONS`
3. ✅ Ensure you have enough balance for the minimum trade size

---

## Step-by-Step Testing Process

### Step 1: Configure Test Settings

1. Open `src/strategies/arbitrage/arbitrage_strategy.ts`
2. Modify the test settings as shown above
3. Save the file

### Step 2: Verify Prerequisites

1. Check GalaChain balances
2. Check Binance balances
3. Verify API keys are set
4. Test API connectivity

### Step 3: Start the Bot

```bash
npm start
```

Or if using Docker:
```bash
docker-compose up
```

### Step 4: Monitor Logs

Watch for:
- Arbitrage opportunity checks
- Trade execution attempts
- Success/failure messages
- Balance changes

### Step 5: Verify Execution

1. Check logs for success messages
2. Check wallet balances changed
3. Check Binance order history
4. Check transaction IDs

---

## Safety Reminders

⚠️ **Before Testing:**
- Start with small amounts
- Use test settings (allow losses)
- Monitor closely
- Have stop-loss ready

⚠️ **After Testing:**
- **Revert test settings** before production
- Set `ALLOW_LOSS_TRADES = false`
- Set realistic `MIN_PROFIT_GALA`
- Use proper minimum amounts

---

## Quick Test Checklist

- [ ] Modified `MIN_PROFIT_GALA` to allow testing
- [ ] Enabled `ALLOW_LOSS_TRADES` (testing only)
- [ ] Lowered `MIN_GALA_AMOUNT` if needed
- [ ] Added smaller trade sizes
- [ ] Verified GalaChain balances
- [ ] Verified Binance balances
- [ ] Verified API keys configured
- [ ] Started the bot
- [ ] Monitoring logs
- [ ] Verified trades executed

---

## Example: Minimal Test Configuration

For the quickest test with minimal risk:

```typescript
// Minimal test config
private readonly MIN_PROFIT_GALA: number = -5; // Allow small losses
private readonly ALLOW_LOSS_TRADES: boolean = true;
private readonly MIN_GALA_AMOUNT: number = 50; // Very small
private readonly TRADE_SIZE_OPTIONS: number[] = [50, 100, 200]; // Small sizes
private readonly ARBITRAGE_CHECK_INTERVAL: number = 10000; // 10 seconds
```

This will execute trades even at small losses, with very small amounts, checking every 10 seconds.

---

## Need Help?

If trades still don't execute:
1. Check logs for specific error messages
2. Verify all prerequisites are met
3. Try even smaller amounts
4. Check API connectivity
5. Review the troubleshooting section above

