<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>readerbox</title></svelte:head>

<main class="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6 py-16">
	{#if data.member}
		<h1 class="text-2xl font-semibold tracking-tight">Salut {data.member.displayName}</h1>
		<p class="mt-2 text-sm text-neutral-500">
			Le journal, les ordres et le graphe arrivent. Pour l’instant tu peux faire entrer quelqu’un.
		</p>

		<div class="mt-8 flex items-center gap-4">
			<a
				href={resolve('/invitations')}
				class="rounded-md bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700"
			>
				Inviter quelqu’un
			</a>

			<form method="POST" action="?/deconnexion">
				<button class="text-sm text-neutral-500 underline underline-offset-4">
					Se déconnecter
				</button>
			</form>
		</div>
	{:else}
		<h1 class="text-2xl font-semibold tracking-tight">readerbox</h1>
		<p class="mt-2 text-sm text-neutral-500">
			Un compagnon de l’univers Marvel, pour un groupe fermé. On n’entre que sur invitation —
			demande son lien à quelqu’un qui est déjà là.
		</p>
	{/if}
</main>
