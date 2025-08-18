openapi: 3.1.0
info:
  title: Alice EntrepreBot API
  version: 1.1.0
servers:
  - url: https://alice-entreprebotza.onrender.com
paths:
  /:
    get:
      operationId: ping
      summary: Health check
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean }
                  service: { type: string }
                  time: { type: string }

  /business/create:
    post:
      operationId: createBusiness
      summary: Create a business
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, industry]
              properties:
                name: { type: string }
                industry: { type: string }
                timezone: { type: string }
      responses:
        "200":
          description: Created
          content:
            application/json:
              schema:
                type: object
                properties:
                  businessId: { type: string }
                  business:
                    type: object
                    properties:
                      name: { type: string }
                      industry: { type: string }
                      timezone: { type: string }
        "400":
          description: Bad request
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /bookings:
    get:
      operationId: listBookings
      summary: List bookings
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/Booking" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
    post:
      operationId: createBooking
      summary: Create booking
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreateBookingRequest" }
      responses:
        "200":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Booking" }
        "400":
          description: Bad request
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /leads:
    post:
      operationId: captureLead
      summary: Capture a lead
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreateLeadRequest" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Lead" }
        "400":
          description: Bad request
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /faqs:
    get:
      operationId: listFaqs
      summary: List FAQs
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/FAQ" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
    post:
      operationId: setFaqs
      summary: Set FAQs
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                items:
                  type: array
                  items: { $ref: "#/components/schemas/FAQ" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean }
        "400":
          description: Bad request
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /insights/weekly:
    post:
      operationId: getWeeklyInsights
      summary: Weekly marketing insights (mock)
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/WeeklyInsights" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /insights/forecast:
    post:
      operationId: forecastRevenue
      summary: Revenue forecast (toy model)
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ForecastRequest" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ForecastResponse" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /staff/create:
    post:
      operationId: createStaff
      summary: Create staff
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
        "400":
          description: Bad request
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401":
          description: Missing or invalid X-Business-Id
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /staff/login:
    post:
      operationId: staffLogin
      summary: Staff login (name + nationalId + pin → JWT)
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/StaffLoginResponse" }
        "401":
          description: Missing or invalid X-Business-Id or wrong credentials
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /staff/agenda:
    get:
      operationId: getStaffAgenda
      summary: Staff agenda (requires Bearer JWT)
      security:
        - bearerAuth: []
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  bookings:
                    type: array
                    items: { $ref: "#/components/schemas/Booking" }
        "401":
          description: Missing/invalid Bearer token
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /staff/clock-in:
    post:
      operationId: staffClockIn
      summary: Clock in (requires Bearer JWT)
      security:
        - bearerAuth: []
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties: { ok: { type: boolean } }
        "401":
          description: Missing/invalid Bearer token
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /staff/clock-out:
    post:
      operationId: staffClockOut
      summary: Clock out (requires Bearer JWT)
      security:
        - bearerAuth: []
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties: { ok: { type: boolean } }
        "401":
          description: Missing/invalid Bearer token
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

  /staff/overtime:
    post:
      operationId: requestOvertime
      summary: Overtime request (requires Bearer JWT)
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/OvertimeRequest" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Overtime" }
        "400":
          description: Bad request
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
        "401":
          description: Missing/invalid Bearer token
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    Error:
      type: object
      properties:
        error: { type: string }

    Booking:
      type: object
      properties:
        id: { type: string }
        businessId: { type: string }
        clientName: { type: string }
        contact: { type: string }
        service: { type: string }
        when: { type: string }
        staffId: { type: string, nullable: true }
        notes: { type: string, nullable: true }
        status: { type: string }

    CreateBookingRequest:
      type: object
      required: [clientName, contact, service, when]
      properties:
        clientName: { type: string }
        contact: { type: string }
        service: { type: string }
        when: { type: string }
        staffId: { type: string, nullable: true }
        notes: { type: string, nullable: true }

    Lead:
      type: object
      properties:
        id: { type: string }
        businessId: { type: string }
        name: { type: string }
        contact: { type: string }
        service: { type: string }
        budget: { type: string }
        source: { type: string }
        notes: { type: string }

    CreateLeadRequest:
      type: object
      required: [name, contact, service]
      properties:
        name: { type: string }
        contact: { type: string }
        service: { type: string }
        budget: { type: string }
        source: { type: string }
        notes: { type: string }

    FAQ:
      type: object
      properties:
        q: { type: string }
        a: { type: string }

    WeeklyInsights:
      type: object
      properties:
        weekOf: { type: string }
        industry: { type: string }
        trends:
          type: array
          items: { type: string }
        suggestedPosts:
          type: array
          items:
            type: object
            properties:
              platform: { type: string }
              day: { type: string }
              time: { type: string }
              caption: { type: string }
        paydayWindows:
          type: array
          items: { type: string }
        forecastNote: { type: string }

    ForecastRequest:
      type: object
      properties:
        baselineWeeklyRevenue: { type: number, default: 10000 }
        marketingSpend: { type: number, default: 1500 }

    ForecastResponse:
      type: object
      properties:
        baselineWeeklyRevenue: { type: number }
        projectedWeeklyRevenue: { type: number }
        assumedLifts:
          type: object
          properties:
            paydayBoost: { type: number }
            trendBoost: { type: number }
        marketingSpend: { type: number }
        estimatedROI: { type: number }

    StaffLoginRequest:
      type: object
      required: [name, nationalId, pin]
      properties:
        name: { type: string }
        nationalId: { type: string }
        pin: { type: string }

    StaffLoginResponse:
      type: object
      properties:
        token: { type: string }
        staff:
          type: object
          properties:
            id: { type: string }
            name: { type: string }
            role: { type: string }

    OvertimeRequest:
      type: object
      required: [hours, reason]
      properties:
        hours: { type: number }
        reason: { type: string }

    Overtime:
      type: object
      properties:
        id: { type: string }
        businessId: { type: string }
        staffId: { type: string }
        hours: { type: number }
        reason: { type: string }
        status: { type: string }
