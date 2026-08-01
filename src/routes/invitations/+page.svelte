<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const dateCourte = (ms: number) =>
		new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
</script>

<svelte:head><title>Invitations — readerbox</title></svelte:head>

<main class="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
	<h1 class="font-display text-2xl leading-none tracking-tight">Inviter quelqu’un</h1>
	<p class="mt-3 text-sm leading-relaxed text-encre-basse">
		Un lien ne vaut qu’une fois et expire au bout d’une semaine. S’il t’échappe avant d’être
		utilisé, révoque-le : c’est le seul rattrapage.
	</p>

	<form method="POST" action="?/emettre" class="mt-6">
		<button class="action">Créer un lien</button>
	</form>

	{#if form?.lien}
		<div class="mt-6 border-l-2 border-or bg-cimaise px-4 py-3">
			<p class="font-display text-base text-encre">
				Voilà le lien. Il ne sera plus jamais affiché.
			</p>
			<code class="mt-2 block text-xs break-all text-or">{form.lien}</code>
		</div>
	{/if}

	{#if form?.message}
		<p class="mt-4 border-l-2 border-braise pl-4 text-sm text-encre-basse">{form.message}</p>
	{/if}

	<h2 class="mt-14 enseigne">Te reconnecter ailleurs</h2>
	<p class="mt-3 text-sm leading-relaxed text-encre-basse">
		Pour ouvrir ta session sur un autre appareil, ou après avoir vidé tes cookies. Ce lien te
		reconnecte <em>toi</em> — il ne crée pas de second compte. Il ne dure qu’une heure et remplace le
		précédent.
	</p>

	<form method="POST" action="?/reconnexion" class="mt-6">
		<button class="action-sourde">Créer un lien de reconnexion</button>
	</form>

	{#if form?.reconnexion}
		<div class="mt-6 border-l-2 border-or bg-cimaise px-4 py-3">
			<p class="font-display text-base text-encre">À ouvrir sur l’autre appareil, dans l’heure.</p>
			<code class="mt-2 block text-xs break-all text-or">{form.reconnexion}</code>
		</div>
	{/if}

	<h2 class="mt-14 enseigne">Tes liens</h2>

	{#if data.liens.length === 0}
		<p class="mt-3 text-sm text-encre-tenue">Tu n’as encore invité personne.</p>
	{:else}
		<ul class="mt-3 border-t border-trait">
			{#each data.liens as lien (lien.id)}
				<li class="flex items-center justify-between gap-4 border-b border-trait py-3">
					<span class="text-sm">
						<span class="font-display tracking-wide text-encre uppercase">{lien.etat}</span>
						<span class="block text-xs text-encre-tenue">
							émis le {dateCourte(lien.creeLe)} · expire le {dateCourte(lien.expireLe)}
						</span>
					</span>

					{#if lien.etat === 'valide'}
						<form method="POST" action="?/revoquer">
							<input type="hidden" name="id" value={lien.id} />
							<button class="risque text-sm">Révoquer</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
