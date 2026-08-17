<svelte:head>
  <title>Torplex Authorization</title>
</svelte:head>

<script>
  import { goto } from '$app/navigation';

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
        error = result.error || 'Authorization rejected';
        return;
      }
      await goto('/');
    } catch {
      error = 'Torplex command link unavailable';
    } finally {
      submitting = false;
    }
  }
</script>

<main class="login-page-shell">
  <section class="authorization-console" aria-labelledby="auth-title">
    <div class="authorization-elbow" aria-hidden="true"><span>SEC</span></div>
    <div class="authorization-content">
      <div class="lcars-text-bar"><span>IDENTITY VERIFICATION</span><i></i><b>47-001</b></div>
      <div class="authorization-grid">
        <div class="authorization-copy">
          <span class="section-eyebrow">Restricted system</span>
          <h1 id="auth-title">Torplex Access</h1>
          <dl>
            <div><dt>NODE</dt><dd>PLEX-PI</dd></div>
            <div><dt>CHANNEL</dt><dd>LOCAL SECURE</dd></div>
            <div><dt>LEVEL</dt><dd>OPERATOR</dd></div>
          </dl>
        </div>
        <form class="login-card" method="post" action="/auth/login" on:submit|preventDefault={login}>
          <label for="password">Authorization code</label>
          <input id="password" name="password" type="password" autocomplete="current-password" bind:value={password} />
          <button class="lcars-button primary-button" type="submit" disabled={submitting}>{submitting ? 'Verifying' : 'Authorize'}</button>
          <div class="login-error" aria-live="polite">{error}</div>
        </form>
      </div>
    </div>
  </section>
</main>
