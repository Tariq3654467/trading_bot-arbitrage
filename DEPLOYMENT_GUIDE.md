# Deployment Guide

## Pre-Deployment Checklist

### 1. Environment Variables Setup

Create a `.env` file in the root directory with the following variables:

#### Required Variables
```bash
# MongoDB
MONGO_PASSWORD=your_secure_password_letters_numbers_only

# GalaChain Wallet
GALA_WALLET_ADDRESS=your_gala_wallet_address
GALA_PRIVATE_KEY=your_gala_private_key

# GalaChain Configuration
GALA_RPC_URL=https://rpc.gala.com
GALASWAP_CONTRACT_NAME=galachain-gala-swap
```

#### Optional but Recommended
```bash
# API Configuration
GALASWAP_API_BASE_URI=https://api-galaswap.gala.com

# Timing Configuration
LOOP_WAIT_MS=15000
EXECUTION_DELAY_MS=0

# Notifications (Discord or Slack)
DISCORD_WEBHOOK_URI=your_discord_webhook_url
DISCORD_ALERT_WEBHOOK_URI=your_discord_alert_webhook_url
# OR
SLACK_WEBHOOK_URI=your_slack_webhook_url
SLACK_ALERT_WEBHOOK_URI=your_slack_alert_webhook_url

# Binance Trading (if enabled)
BINANCE_ENABLED=false
BINANCE_API_KEY=your_binance_api_key
BINANCE_API_SECRET=your_binance_api_secret
BINANCE_API_BASE_URI=https://api.binance.com
```

### 2. Configuration Files Review

Review and adjust these files in the `config/` directory:

- **`basic_swap_creator.json`**: Adjust swap targets, profitability, and limits
- **`basic_swap_accepter.json`**: Configure swap acceptance criteria
- **`token_config.json`**: Set price limits and project tokens

**Important**: Make sure `targetGivingSize` values match your available balances!

### 3. Verify Prerequisites

- [ ] Docker and Docker Compose installed
- [ ] `.env` file created with all required variables
- [ ] GalaChain wallet has sufficient GALA for fees
- [ ] Configuration files reviewed and adjusted
- [ ] Binance API keys configured (if using Binance trading)

## Deployment Steps

### Step 1: Build and Start Services

```bash
# Build and start all services in detached mode
docker compose up --build -d
```

### Step 2: Verify Services are Running

```bash
# Check container status
docker compose ps

# View bot logs
docker logs -f galaswap-bot-bot-1

# View MongoDB logs
docker logs -f galaswap-bot-mongo-1
```

### Step 3: Monitor Initial Startup

Watch the logs for:
- ✅ "Bot started successfully"
- ✅ "GalaChain router initialized"
- ✅ "Processing swap targets"
- ❌ Any error messages

## Post-Deployment Monitoring

### Check Bot Status

```bash
# Follow logs in real-time
docker logs -f galaswap-bot-bot-1

# Check last 100 lines
docker logs --tail 100 galaswap-bot-bot-1

# Check for errors
docker logs galaswap-bot-bot-1 2>&1 | grep -i error
```

### Common Issues and Solutions

#### Issue: Bot not creating swaps
**Check**: 
- Verify balances are sufficient for `targetGivingSize`
- Check logs for "insufficient balance" messages
- Review `config/basic_swap_creator.json` settings

#### Issue: Binance API errors (401)
**Solution**:
1. Verify API key and secret in `.env`
2. Check Binance API key permissions
3. Whitelist server IP in Binance API settings
4. Test API key manually

#### Issue: Swaps failing with CONFLICT errors
**Solution**:
- Swap amounts may be too small
- Check logs for quantity validation messages
- Increase `targetGivingSize` in config

#### Issue: MongoDB connection errors
**Solution**:
```bash
# Restart MongoDB service
docker compose restart mongo

# Check MongoDB logs
docker logs galaswap-bot-mongo-1
```

## Maintenance Commands

### Restart Bot
```bash
docker compose restart bot
```

### Rebuild and Restart
```bash
docker compose down
docker compose up --build -d
```

### Stop Bot
```bash
docker compose down
```

### Update Configuration
```bash
# After editing config files, restart bot
docker compose restart bot
```

### View Database
```bash
# MongoDB is accessible on port 50002
# Connect using: mongodb://root:YOUR_MONGO_PASSWORD@localhost:50002/?authSource=admin
```

## Production Recommendations

### 1. Start Small
- Begin with small `targetGivingSize` values
- Monitor for 24-48 hours
- Gradually increase amounts

### 2. Set Up Alerts
- Configure Discord/Slack webhooks
- Monitor for error notifications
- Set up balance alerts

### 3. Regular Monitoring
- Check logs daily
- Monitor swap success rates
- Track profitability
- Review balance changes

### 4. Security
- Keep `.env` file secure (never commit to git)
- Use strong MongoDB password
- Rotate API keys periodically
- Backup wallet private key securely

### 5. Performance Tuning
- Adjust `LOOP_WAIT_MS` based on trading frequency
- Set `EXECUTION_DELAY_MS` for rate limiting
- Monitor API rate limits

## Troubleshooting

### Bot Not Starting
```bash
# Check Docker logs
docker compose logs bot

# Verify environment variables
docker compose config

# Check if MongoDB is running
docker compose ps mongo
```

### Swaps Not Executing
1. Check wallet balance
2. Verify configuration matches available balances
3. Review logs for skip reasons
4. Check if strategies are enabled in config

### High Error Rate
1. Check API connectivity
2. Verify RPC URL is accessible
3. Review rate limiting settings
4. Check for network issues

## Rollback Procedure

If you need to rollback:

```bash
# Stop current deployment
docker compose down

# Restore previous configuration
# (if using version control)
git checkout previous-version

# Restart with previous config
docker compose up --build -d
```

## Support

For issues:
1. Check logs: `docker logs galaswap-bot-bot-1`
2. Review configuration files
3. Verify environment variables
4. Check PRODUCTION_READINESS_CHECKLIST.md

