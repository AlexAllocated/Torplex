<svelte:head>
  <title>Torplex Login</title>
</svelte:head>

<script>
  import { goto } from '$app/navigation';
  import '../../dashboard.css';

  let password = '';
  let error = '';
  let submitting = false;

  async function login() {
    if (submitting) return;
    submitting = true;
    error = '';
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) {
        error = result.error || 'Unable to sign in';
        return;
      }
      await goto('/');
    } catch {
      error = 'Unable to reach Torplex';
    } finally {
      submitting = false;
    }
  }
</script>

<main class="login-page-shell">
  <form class="login-card" method="post" action="/auth/login" on:submit|preventDefault={login}>
    <div class="login-register">&gt; AUTH_GATE / TORPLEX</div>
    <h1>Torplex</h1>
    <p>Enter the server password to continue.</p>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" bind:value={password} />
    <button class="primary-button" type="submit" disabled={submitting}>{submitting ? 'Authenticating...' : 'Unlock'}</button>
    <div class="login-error" aria-live="polite">{error}</div>
  </form>
</main>
