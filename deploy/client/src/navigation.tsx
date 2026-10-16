import type { ComponentProps } from "react";
import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
	window.addEventListener("popstate", listener);
	return () => window.removeEventListener("popstate", listener);
};
/** Change local pages without discarding the wallet connection or in-memory tokens. */
export function navigate(path: string, replace = false) {
	if (replace) history.replaceState({}, "", path);
	else history.pushState({}, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
}
export function usePage() {
	return useSyncExternalStore(
		subscribe,
		() => location.pathname + location.search,
		() => "/",
	);
}
/** Preserve the signed OAuth interaction when choosing another login method. */
export function loginLink(path: string, search = location.search) {
	return `${path}${search}`;
}
export function PageLink({
	href,
	onClick,
	...props
}: ComponentProps<"a"> & { href: string }) {
	return (
		<a
			{...props}
			href={href}
			onClick={(event) => {
				onClick?.(event);
				if (
					!event.defaultPrevented &&
					event.button === 0 &&
					!event.metaKey &&
					!event.ctrlKey &&
					!event.shiftKey &&
					!event.altKey &&
					!props.target
				) {
					event.preventDefault();
					navigate(href);
				}
			}}
		/>
	);
}
