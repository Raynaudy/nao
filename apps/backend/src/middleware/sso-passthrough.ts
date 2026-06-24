import { createHmac } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { getAuth } from '../auth';
import { env } from '../env';
import { convertHeaders } from '../utils/utils';

/**
 * Establishes a Better Auth session from a trusted reverse-proxy identity header
 * (Databricks Apps forwards the authenticated user as X-Forwarded-Email), so the
 * Databricks login is the only login — nao's sign-in screen is never shown.
 *
 * Runs only on SPA navigations that have no session yet. The per-user password is
 * derived deterministically from BETTER_AUTH_SECRET + email, so it is stable and
 * never exposed. Uses Better Auth's public sign-in/up APIs so the session cookie
 * is signed correctly.
 */
export async function ssoPassthrough(request: FastifyRequest, reply: FastifyReply) {
	if (!env.NAO_SSO_PASSTHROUGH || request.method !== 'GET') {
		return;
	}

	const path = request.url.split('?', 1)[0];
	if (isNonNavigation(path)) {
		return;
	}

	const email = forwardedEmail(request);
	if (!email) {
		request.log.info('[sso] no x-forwarded-email on navigation; skipping passthrough');
		return;
	}
	const name = (request.headers['x-forwarded-preferred-username'] as string) || email.split('@')[0];

	// Never let SSO establishment break a page load — fall back to the login screen.
	try {
		const auth = await getAuth();
		const headers = convertHeaders(request.headers);
		// Validate the actual session (don't trust a possibly-stale cookie) so a
		// dead cookie doesn't block re-establishing a session.
		if ((await auth.api.getSession({ headers }))?.user) {
			return;
		}

		const password = createHmac('sha256', env.BETTER_AUTH_SECRET).update(email.toLowerCase()).digest('hex');

		let response = await trySignIn(auth, email, password);
		if (!response) {
			await trySignUp(auth, email, password, name);
			response = await trySignIn(auth, email, password);
		}
		const cookies = response?.headers.getSetCookie?.() ?? [];
		for (const cookie of cookies) {
			reply.header('set-cookie', cookie);
		}
		request.log.info(`[sso] ${email}: signed-in=${!!response} cookies=${cookies.length}`);
	} catch (err) {
		request.log.warn(`[sso] passthrough failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function isNonNavigation(path: string): boolean {
	return (
		path.startsWith('/api') ||
		path.startsWith('/.well-known') ||
		path.startsWith('/branding') ||
		path.startsWith('/mcp') ||
		path.startsWith('/c/') ||
		path.startsWith('/i/') ||
		path.includes('.') // static assets (foo.js, foo.css, favicon.ico, …)
	);
}

function forwardedEmail(request: FastifyRequest): string | undefined {
	const value = request.headers['x-forwarded-email'] ?? request.headers['x-forwarded-preferred-username'];
	const email = Array.isArray(value) ? value[0] : value;
	return email && email.includes('@') ? email : undefined;
}

async function trySignIn(
	auth: Awaited<ReturnType<typeof getAuth>>,
	email: string,
	password: string,
): Promise<Response | null> {
	try {
		const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
		return response.ok ? response : null;
	} catch {
		return null;
	}
}

async function trySignUp(
	auth: Awaited<ReturnType<typeof getAuth>>,
	email: string,
	password: string,
	name: string,
): Promise<void> {
	try {
		await auth.api.signUpEmail({ body: { email, password, name }, asResponse: true });
	} catch {
		// User may already exist (race) — sign-in retry handles it.
	}
}
