<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const dateCourte = (ms: number) =>
		new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
</script>

<svelte:head><title>Invitations — readerbox</title></svelte:head>

<main class="mx-auto max-w-2xl px-6 py-16">
	<a href={resolve('/')} class="text-sm text-neutral-500 underline underline-offset-4">Retour</a>

	<h1 class="mt-6 text-2xl font-semibold tracking-tight">Inviter quelqu’un</h1>
	<p class="mt-2 text-sm text-neutral-500">
		Un lien ne vaut qu’une fois et expire au bout d’une semaine. S’il t’échappe avant d’être
		utilisé, révoque-le : c’est le seul rattrapage.
	</p>

	<form method="POST" action="?/emettre" class="mt-6">
		<button class="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700">
			Créer un lien
		</button>
	</form>

	{#if form?.lien}
		<div class="mt-4 rounded-md border border-neutral-300 bg-neutral-50 p-4">
			<p class="text-sm font-medium">Voilà le lien. Il ne sera plus jamais affiché.</p>
			<code class="mt-2 block text-xs break-all text-neutral-700">{form.lien}</code>
		</div>
	{/if}

	{#if form?.message}
		<p class="mt-4 text-sm text-red-600">{form.message}</p>
	{/if}

	<h2 class="mt-12 text-sm font-semibold tracking-tight">Tes liens</h2>

	{#if data.liens.length === 0}
		<p class="mt-2 text-sm text-neutral-500">Tu n’as encore invité personne.</p>
	{:else}
		<ul class="mt-2 divide-y divide-neutral-200">
			{#each data.liens as lien (lien.id)}
				<li class="flex items-center justify-between gap-4 py-3">
					<div class="text-sm">
						<span class="font-medium">{lien.etat}</span>
						<span class="text-neutral-500">
							· émis le {dateCourte(lien.creeLe)} · expire le {dateCourte(lien.expireLe)}
						</span>
					</div>

					{#if lien.etat === 'valide'}
						<form method="POST" action="?/revoquer">
							<input type="hidden" name="id" value={lien.id} />
							<button class="text-sm text-red-600 underline underline-offset-4">Révoquer</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</main>
