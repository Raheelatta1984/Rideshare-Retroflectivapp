#!/usr/bin/env node

/**
 * Arena.ai GitHub Webhook Handler for Retroflex
 * Automatically triggers deployment on push to main branch
 * 
 * Setup:
 * 1. Deploy this to: https://webhook.retroflex.app/github
 * 2. Add GitHub webhook: Settings → Webhooks → Add webhook
 *    - Payload URL: https://webhook.retroflex.app/github
 *    - Events: Push events
 *    - Secret: GITHUB_WEBHOOK_SECRET env var
 */

import crypto from 'crypto';
import https from 'https';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const ARENA_DEPLOY_KEY = process.env.ARENA_DEPLOY_KEY || '';
const ARENA_PROJECT_ID = process.env.ARENA_PROJECT_ID || '';
const REPO = 'Raheelatta1984/Rideshare-Retroflectivapp';

interface GitHubPushEvent {
  ref: string;
  repository: {
    full_name: string;
    default_branch: string;
  };
  pusher: {
    name: string;
    email: string;
  };
  commits: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: { name: string; email: string };
  }>;
}

interface DeployResponse {
  success: boolean;
  deploymentId?: string;
  status?: string;
  error?: string;
  url?: string;
}

// Verify GitHub webhook signature
function verifyGitHubSignature(body: string, signature: string): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    console.warn('⚠️  GITHUB_WEBHOOK_SECRET not set - skipping verification');
    return true;
  }
  
  const hash = crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  
  const expectedSignature = `sha256=${hash}`;
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signature)
  );
}

// Trigger Arena.ai deployment
function triggerArenaDeploy(): Promise<DeployResponse> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      repository: REPO,
      branch: 'main',
      trigger: 'github-webhook',
      timestamp: new Date().toISOString(),
    });

    const options = {
      hostname: 'api.arena.ai',
      path: `/v1/projects/${ARENA_PROJECT_ID}/deployments`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${ARENA_DEPLOY_KEY}`,
        'User-Agent': 'Retroflex-Webhook/1.0',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve({
              success: true,
              deploymentId: response.id,
              status: response.status,
              url: response.url,
            });
          } else {
            resolve({
              success: false,
              error: response.message || `HTTP ${res.statusCode}`,
            });
          }
        } catch (err) {
          resolve({
            success: false,
            error: `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        success: false,
        error: `Request failed: ${err.message}`,
      });
    });

    req.write(payload);
    req.end();
  });
}

// Main webhook handler
export async function handler(event: any): Promise<any> {
  const body = typeof event.body === 'string' ? event.body : JSON.stringify(event.body);
  const signature = event.headers['x-hub-signature-256'] || event.headers['X-Hub-Signature-256'] || '';
  const eventType = event.headers['x-github-event'] || event.headers['X-GitHub-Event'] || '';

  console.log(`📨 Webhook received: ${eventType}`);

  // Verify signature
  if (!verifyGitHubSignature(body, signature)) {
    console.error('❌ Invalid GitHub signature');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  // Only handle push events
  if (eventType !== 'push') {
    console.log(`⏭️  Skipping event type: ${eventType}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Event ignored' }),
    };
  }

  try {
    const payload: GitHubPushEvent = JSON.parse(body);

    // Only deploy on main branch push
    if (payload.ref !== 'refs/heads/main') {
      console.log(`⏭️  Skipping branch: ${payload.ref}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Only main branch triggers deploy' }),
      };
    }

    // Verify it's the right repo
    if (payload.repository.full_name !== REPO) {
      console.error(`❌ Wrong repository: ${payload.repository.full_name}`);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Wrong repository' }),
      };
    }

    console.log(`\n🚀 Deploying ${REPO}...`);
    console.log(`📝 Commits: ${payload.commits.length}`);
    payload.commits.forEach((commit) => {
      console.log(`   • ${commit.id.slice(0, 7)} - ${commit.message.split('\n')[0]}`);
    });

    // Trigger deployment
    const deployResult = await triggerArenaDeploy();

    if (deployResult.success) {
      console.log(`✅ Deployment triggered!`);
      console.log(`   ID: ${deployResult.deploymentId}`);
      console.log(`   Status: ${deployResult.status}`);
      if (deployResult.url) {
        console.log(`   URL: ${deployResult.url}`);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          deploymentId: deployResult.deploymentId,
          status: deployResult.status,
          url: deployResult.url,
          message: 'Deployment triggered successfully',
        }),
      };
    } else {
      console.error(`❌ Deployment failed: ${deployResult.error}`);
      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          error: deployResult.error,
        }),
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Error: ${message}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: message }),
    };
  }
}

// Express middleware for local testing
export function webhookHandler(req: any, res: any) {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    const response = await handler({
      headers: req.headers,
      body,
    });
    res.statusCode = response.statusCode;
    res.end(response.body);
  });
}
