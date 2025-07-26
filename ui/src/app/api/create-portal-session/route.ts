import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log('Creating portal session for:', body.userEmail);

    const backendUrl = process.env.REST_API_ENDPOINT;
    console.log('Backend URL:', backendUrl);

    const response = await fetch(`${backendUrl}/api/create-portal-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userEmail: body.userEmail
      }),
    });

    console.log('Portal session response status:', response.status);

    if (!response.ok) {
      const error = await response.text();
      console.error('Portal session creation failed:', error);
      return new Response(error, { status: response.status });
    }

    const data = await response.json();
    console.log('Portal session created successfully:', data);
    return Response.json(data);
  } catch (err) {
    console.error('Error in portal session creation:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to create portal session' }),
      { status: 500 }
    );
  }
}
