import { NextResponse } from "next/server";
import { deleteReference, sweepReferences } from "../../../lib/temporary-images";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const receipt = new URL(request.url).searchParams.get("receipt");
    if (!receipt) return NextResponse.json({ error: "Missing cleanup receipt." }, { status: 400 });
    const body = await request.json();
    const status = String(body.data?.status ?? body.status ?? "").toUpperCase();
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status) || ["run.completed", "run.failed", "run.cancelled"].includes(body.event)) {
      await deleteReference(receipt);
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Image cleanup failed." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return NextResponse.json({ deleted: await sweepReferences() });
}
