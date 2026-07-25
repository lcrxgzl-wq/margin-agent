type RequestEvents = {
  on(event: "aborted", listener: () => void): unknown;
  off(event: "aborted", listener: () => void): unknown;
};

type ResponseEvents = {
  readonly writableEnded: boolean;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
};

export function abortOnClientDisconnect(
  request: RequestEvents,
  response: ResponseEvents,
  controller: AbortController,
): () => void {
  const onDisconnect = () => {
    if (!response.writableEnded && !controller.signal.aborted) controller.abort();
  };

  request.on("aborted", onDisconnect);
  response.on("close", onDisconnect);

  return () => {
    request.off("aborted", onDisconnect);
    response.off("close", onDisconnect);
  };
}
