import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
  NodeApiError,
  JsonObject,
  NodeConnectionType,
  INodeInputConfiguration,
  INodeOutputConfiguration,
  IRequestOptions,
  IHttpRequestMethods,
} from 'n8n-workflow';
import { OAuth1Helper } from './TwitterUtils';
import FormData from 'form-data';
import { request } from 'https';
import * as fs from 'fs';

export class TwitterMediaUpload implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Twitter Media Upload',
    name: 'twitterMediaUpload',
    icon: 'file:twitter.svg',
    group: ['transform'],
    version: 1,
    description: 'Upload media to Twitter',
    defaults: {
      name: 'Twitter Media Upload',
      color: '#1DA1F2',
    },
    inputs: ['main'] as (NodeConnectionType | INodeInputConfiguration)[],
    outputs: ['main'] as (NodeConnectionType | INodeOutputConfiguration)[],

    credentials: [
      {
        name: 'twitterApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Binary Property',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        description: 'Name of the binary property that contains the image',
      },
      {
        displayName: 'Media Data',
        name: 'mediaData',
        type: 'string',
        default: '',
        required: false,
        description: 'Media data parameter'
      },
      {
        displayName: 'Additional Owners',
        name: 'additionalOwners',
        type: 'string',
        default: '',
        required: false,
        description: 'A comma-separated list of user IDs to set as additional owners allowed to use the media. Up to 100 additional owners can be specified.',
        placeholder: '12345,67890',
      },
      {
        displayName: 'Media Category',
        name: 'mediaCategory',
        type: 'string',
        default: 'tweet_image',
        required: false,
        description: 'The category that represents how the media will be used. For tweets, use tweet_image (default), tweet_gif, or tweet_video.',
        placeholder: 'tweet_image',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    // Get credentials
    const credentials = await this.getCredentials('twitterApi');
    console.log('Credentials Source:', credentials);
    if (!credentials) {
      throw new NodeOperationError(this.getNode(), 'No credentials provided');
    }

    // Validate required OAuth fields
    const requiredFields = [
      { field: 'consumerKey', label: 'Consumer Key' },
      { field: 'consumerSecret', label: 'Access Token' },
      { field: 'accessToken', label: 'Access Token' },
      { field: 'accessSecret', label: 'Access Token Secret' }
    ];

    for (const { field, label } of requiredFields) {
      if (!credentials[field]?.toString()) {
        throw new NodeOperationError(
          this.getNode(),
          `Missing required Twitter OAuth credential: ${label}`
        );
      }
    }

    console.log('Twitter credentials validated successfully');

    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    const logMediaProperties = (binaryPropertyName: string, mediaData: string | null, mediaCategory: string | null) => {
      console.log('Media Properties:');
      console.log(`  binaryPropertyName: ${binaryPropertyName} (Name of the binary property containing the image data)`);
      console.log(`  mediaData: ${mediaData ? 'Provided' : 'Not Provided'} (Media data as a string, overrides binaryPropertyName if provided)`);
      console.log(`  mediaCategory: ${mediaCategory || 'Not Provided'} (Category that represents how media will be used)`);
    }

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        // Get binary property name
        const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex) as string;

        // Check if mediaData parameter exists and use it, otherwise use binary data
        let mediaData;
        try {
          mediaData = this.getNodeParameter('mediaData', itemIndex) as string;
          console.log('Found mediaData parameter');
        } catch (error) {
          // If mediaData parameter doesn't exist, use binary data instead
          console.log('mediaData parameter not found, using binary data instead');
          mediaData = null;
        }

        // Get media category if provided
        let mediaCategory;
        try {
          mediaCategory = this.getNodeParameter('mediaCategory', itemIndex) as string;
        } catch (error) {
          console.log('Media category not specified, using default');
          mediaCategory = null;
        }

        logMediaProperties(binaryPropertyName, mediaData, mediaCategory);

        // Debug log available binary properties
        console.log('Available binary properties:', Object.keys(items[itemIndex].binary || {}));
        console.log('Requested binary property:', binaryPropertyName);

        // Try to find binary data - first check specified property, then look for any image
        let actualPropertyName = binaryPropertyName;

        if (!items[itemIndex].binary?.[binaryPropertyName]) {
          console.log(`Binary property "${binaryPropertyName}" not found, searching for alternatives...`);
          const binaryKeys = Object.keys(items[itemIndex].binary || {});
          const imageKey = binaryKeys.find(key =>
            items[itemIndex].binary![key].mimeType?.startsWith('image/')
          );

          if (imageKey) {
            console.log(`Found alternative image property: "${imageKey}"`);
            actualPropertyName = imageKey;
          } else {
            throw new NodeOperationError(
              this.getNode(),
              `No binary data found in property "${binaryPropertyName}" and no image alternatives found`
            );
          }
        }

        // Get binary data
        const binaryData = await this.helpers.getBinaryDataBuffer(itemIndex, actualPropertyName);

        // Extract file information
        const mediaType = items[itemIndex].binary![actualPropertyName].mimeType;
        const fileName = items[itemIndex].binary![actualPropertyName].fileName || 'image.jpg';

        // Debug log binary data details
        console.log('Binary data details:', {
          fileName,
          mediaType,
          dataSize: binaryData.length,
        });

        // Validate media type
        if (!mediaType || !mediaType.startsWith('image/')) {
          throw new NodeOperationError(
            this.getNode(),
            `Invalid media type: ${mediaType}. Only images are supported.`
          );
        }

        // Create request options using form data approach
        const requestUrl = 'https://upload.twitter.com/1.1/media/upload.json';

        // Create OAuth helper instance
        const oauth = new OAuth1Helper({
          consumerKey: credentials.consumerKey as string,
          consumerSecret: credentials.consumerSecret as string,
          accessToken: credentials.accessToken as string,
          accessSecret: credentials.accessSecret as string
        }, this.getNode());

        // Create params for OAuth header
        const oauthParams: Record<string, string> = {
          command: 'INIT',
          totalBytes: String(binaryData.length),
          mediaType: mediaType,
        };

        // Add media_category to params if provided
        if (mediaCategory) {
          oauthParams.media_category = mediaCategory;
        }

        // Generate authorization header
        const authHeader = oauth.generateAuthHeader({
          url: requestUrl,
          method: 'POST',
          params: oauthParams,
        });

        const formData = new FormData();
        formData.append('command', 'INIT');
        const totalBytes = String(binaryData.length);
        if (isNaN(Number(totalBytes))) {
          throw new NodeOperationError(this.getNode(), 'totalBytes must be a number');
        }
        formData.append('totalBytes', totalBytes);

        if (!mediaType || !mediaType.startsWith('image/')) {
          throw new NodeOperationError(
            this.getNode(),
            `Invalid media type: ${mediaType}. Only images are supported.`
          );
        }
        formData.append('mediaType', mediaType);

        // Add media_category to form data if provided
        if (mediaCategory) {
          formData.append('media_category', mediaCategory);
        }

        formData.append('media', binaryData, fileName);

        // Add additional owners if provided
        try {
          const additionalOwners = this.getNodeParameter('additionalOwners', itemIndex) as string;
          if (additionalOwners) {
            // Clean up and validate the additional owners list
            const ownersList = additionalOwners
              .split(',')
              .map(id => id.trim())
              .filter(id => id.length > 0);

            if (ownersList.length > 100) {
              throw new NodeOperationError(
                this.getNode(),
                'Maximum of 100 additional owners allowed'
              );
            }

            formData.append('additional_owners', ownersList.join(','));
          }
        } catch (error: unknown) {
          // If parameter doesn't exist or there's an error, continue without additional owners.
          if (error instanceof Error) {
            console.log('No additional owners specified or error occurred:', error.message);
          }
        }

        const requestHeaders = {
          authorization: authHeader,
          ...formData.getHeaders(),
        };
        console.log('Sending request to Twitter API with FormData and manual OAuth...', {
          url: requestUrl,
          headers: requestHeaders,
        });

        const response = await new Promise<any>((resolve, reject) => {
          const req = request(
            requestUrl,
            {
              method: 'POST',
              headers: requestHeaders,
            },
            (res) => {
              let data = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                data += chunk;
              });

              res.on('end', () => {
                let responseBody;
                try {
                  responseBody = JSON.parse(data);
                } catch (e) {
                  responseBody = data;
                }

                resolve({
                  statusCode: res.statusCode,
                  headers: res.headers,
                  body: responseBody
                });
              });
              res.on('error', (err) => reject(err));
            }
          );

          formData.pipe(req);

          req.on('error', (error) => {
            reject(error);
          });
        });

        console.log('Response received:', {
          statusCode: response.statusCode,
          body: JSON.stringify(response.body)
        });

        // Check for error response
        if (response.statusCode >= 400) {
          throw new NodeApiError(this.getNode(), response.body, { httpCode: response.statusCode });
        }

        // Add the response to the output
        returnData.push({
          json: {
            success: true,
            ...response.body,
          },
        });

      } catch (error: any) {
          console.error('Error in TwitterMediaUpload:', error.message);

          if (error.response) {
            console.error('Response error details:', {
              statusCode: error.response.statusCode,
              body: error.response.body
            });
          }

          if (error instanceof NodeOperationError) {
            console.error('NodeOperationError:', error.message);
          } else if (error instanceof NodeApiError) {
            console.error('NodeApiError:', error.message);
          } else {
            console.error('Unexpected error:', error.message);
          }

          if (this.continueOnFail()) {
            returnData.push({
              json: {
                success: false,
                error: error.message,
                details: error.response?.body
              }
            });
            continue;
          }
          throw error;
        }
    }

    return [returnData];
  }
}
